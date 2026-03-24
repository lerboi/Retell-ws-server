/**
 * Custom LLM WebSocket server for Retell AI.
 *
 * Retell connects here for each call. This server:
 * 1. Receives conversation transcripts from Retell via WebSocket
 * 2. Sends them to Groq (Llama 4 Scout) for inference
 * 3. Streams response tokens back to Retell for text-to-speech
 * 4. Handles tool calls (transfer_call, book_appointment, capture_lead, end_call) via Retell's protocol
 *
 * Deploy this as a standalone service (Railway, Render, Fly.io, etc.)
 *
 * Environment variables:
 *   GROQ_API_KEY  - Required. Get one at https://console.groq.com/keys
 *   PORT          - Optional. Defaults to 8081. Railway/Render set this automatically.
 */

import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { buildSystemPrompt } from './agent-prompt.js';

const PORT = parseInt(process.env.PORT || '8081', 10);

let _groq = null;
function getGroq() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY environment variable is required. Get one at https://console.groq.com/keys');
    }
    _groq = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return _groq;
}

// ─── Tool definitions (OpenAI format for Groq) ─────────────────────────────

function getTools(onboardingComplete) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'transfer_call',
        description:
          "Transfer the current call to the business owner's phone number. " +
          'Use when the caller explicitly requests a human, or after 3 failed clarification attempts. ' +
          'Always capture caller info (name, phone, issue) BEFORE invoking unless caller explicitly requests immediate transfer.',
        parameters: {
          type: 'object',
          properties: {
            caller_name: { type: 'string', description: 'Caller full name if captured' },
            job_type: { type: 'string', description: 'Type of job or service needed' },
            urgency: {
              type: 'string',
              enum: ['emergency', 'routine', 'high_ticket'],
              description: 'Urgency level detected from conversation',
            },
            summary: { type: 'string', description: '1-line summary of caller request for the receiving human' },
          },
          required: [],
        },
      },
    },
  ];

  // capture_lead — always available, NOT gated by onboardingComplete
  tools.push({
    type: 'function',
    function: {
      name: 'capture_lead',
      description:
        'Capture caller information as a lead when they decline booking. ' +
        'Use after the second explicit decline. Invoke BEFORE end_call.',
      parameters: {
        type: 'object',
        properties: {
          caller_name: { type: 'string', description: 'Caller full name' },
          phone: { type: 'string', description: 'Caller phone number if provided' },
          address: { type: 'string', description: 'Service address if provided' },
          job_type: { type: 'string', description: 'Type of job or service needed' },
          notes: { type: 'string', description: 'Any additional context from the conversation' },
        },
        required: [],
      },
    },
  });

  // end_call — always available, NOT gated by onboardingComplete
  tools.push({
    type: 'function',
    function: {
      name: 'end_call',
      description:
        'End the call gracefully after all actions are complete. ' +
        'Always invoke capture_lead BEFORE end_call if no booking was made.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  });

  if (onboardingComplete) {
    tools.push({
      type: 'function',
      function: {
        name: 'book_appointment',
        description:
          'Book a confirmed appointment slot. Only invoke AFTER: ' +
          '(1) collecting caller name and service address, ' +
          '(2) reading back the address and receiving verbal confirmation, ' +
          '(3) the caller has selected a slot.',
        parameters: {
          type: 'object',
          properties: {
            slot_start: { type: 'string', description: 'ISO 8601 datetime of appointment start' },
            slot_end: { type: 'string', description: 'ISO 8601 datetime of appointment end' },
            service_address: { type: 'string', description: 'Verbally confirmed service address' },
            caller_name: { type: 'string', description: 'Caller full name' },
            urgency: {
              type: 'string',
              enum: ['emergency', 'routine', 'high_ticket'],
              description: 'Urgency level',
            },
          },
          required: ['slot_start', 'slot_end', 'service_address', 'caller_name', 'urgency'],
        },
      },
    });
  }

  return tools;
}

// ─── WebSocket server ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

console.log(`[retell-ws] Listening on port ${PORT}`);

wss.on('connection', (ws, req) => {
  // Extract call_id from URL path: /llm-websocket/{call_id}
  const urlParts = req.url?.split('/') || [];
  const callId = urlParts[urlParts.length - 1];
  console.log(`[retell-ws] New connection: call_id=${callId}`);

  // Per-call state
  let systemPrompt = '';
  let tools = getTools(false);
  let pendingToolCalls = new Map();

  // Send config on connect
  ws.send(
    JSON.stringify({
      response_type: 'config',
      config: {
        auto_reconnect: true,
        call_details: true,
      },
    })
  );

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error('[retell-ws] Failed to parse message:', data.toString().slice(0, 200));
      return;
    }

    // ── Ping/pong keepalive ──
    if (msg.interaction_type === 'ping_pong') {
      ws.send(
        JSON.stringify({
          response_type: 'ping_pong',
          timestamp: msg.timestamp,
        })
      );
      return;
    }

    // ── Call details (first message after config) ──
    if (msg.interaction_type === 'call_details') {
      const callDetails = msg.call;
      const vars = callDetails?.retell_llm_dynamic_variables || {};

      const locale = vars.default_locale || 'en';
      const businessName = vars.business_name || 'Voco';
      const onboardingComplete = vars.onboarding_complete === true || vars.onboarding_complete === 'true';
      const tonePreset = vars.tone_preset || 'professional';

      systemPrompt = buildSystemPrompt(locale, {
        business_name: businessName,
        onboarding_complete: onboardingComplete,
        tone_preset: tonePreset,
      });

      if (vars.available_slots && vars.available_slots !== 'No available slots') {
        systemPrompt += `\n\nAVAILABLE APPOINTMENT SLOTS:\n${vars.available_slots}`;
      }

      tools = getTools(onboardingComplete);
      console.log(
        `[retell-ws] Call details: business=${businessName}, locale=${locale}, ` +
          `onboarding=${onboardingComplete}, tone=${tonePreset}`
      );

      const greeting = onboardingComplete
        ? `Hello, thank you for calling ${businessName}. This call may be recorded for quality purposes. How can I help you today?`
        : `Hello, this call may be recorded for quality purposes. How can I help you today?`;

      ws.send(
        JSON.stringify({
          response_type: 'response',
          response_id: 0,
          content: greeting,
          content_complete: true,
          end_call: false,
        })
      );
      return;
    }

    // ── Tool call result from Retell ──
    if (msg.interaction_type === 'tool_call_result') {
      const { tool_call_id, content } = msg;
      const pending = pendingToolCalls.get(tool_call_id);
      if (pending) {
        pendingToolCalls.delete(tool_call_id);
        await handleToolResult(ws, msg.response_id, pending, content, msg.transcript);
      }
      return;
    }

    // ── Update only ──
    if (msg.interaction_type === 'update_only') {
      return;
    }

    // ── Response required or reminder required ──
    if (msg.interaction_type === 'response_required' || msg.interaction_type === 'reminder_required') {
      await handleResponseRequired(ws, msg);
      return;
    }
  });

  ws.on('close', () => {
    console.log(`[retell-ws] Connection closed: call_id=${callId}`);
  });

  ws.on('error', (err) => {
    console.error(`[retell-ws] WebSocket error: call_id=${callId}`, err.message);
  });

  // ── Handle response_required: call Groq and stream back ──

  async function handleResponseRequired(ws, msg) {
    const { response_id, transcript } = msg;

    const messages = [{ role: 'system', content: systemPrompt }];

    if (transcript && transcript.length > 0) {
      for (const turn of transcript) {
        messages.push({
          role: turn.role === 'agent' ? 'assistant' : 'user',
          content: turn.content,
        });
      }
    }

    if (msg.interaction_type === 'reminder_required') {
      messages.push({
        role: 'user',
        content: '(The caller has been silent. Gently check if they are still there or need help.)',
      });
    }

    try {
      const stream = await getGroq().chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        temperature: 0.3,
        max_tokens: 500,
      });

      let toolCallAccumulator = {};

      for await (const chunk of stream) {
        if (ws.readyState !== ws.OPEN) break;

        const delta = chunk.choices?.[0]?.delta;
        const finishReason = chunk.choices?.[0]?.finish_reason;

        if (delta?.content) {
          ws.send(
            JSON.stringify({
              response_type: 'response',
              response_id,
              content: delta.content,
              content_complete: false,
              end_call: false,
            })
          );
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulator[idx]) {
              toolCallAccumulator[idx] = { id: '', name: '', arguments: '' };
            }
            if (tc.id) toolCallAccumulator[idx].id = tc.id;
            if (tc.function?.name) toolCallAccumulator[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallAccumulator[idx].arguments += tc.function.arguments;
          }
        }

        if (finishReason === 'stop') {
          ws.send(
            JSON.stringify({
              response_type: 'response',
              response_id,
              content: '',
              content_complete: true,
              end_call: false,
            })
          );
        }

        if (finishReason === 'tool_calls') {
          for (const [, tc] of Object.entries(toolCallAccumulator)) {
            const toolCallId = tc.id || `tc_${Date.now()}_${tc.name}`;
            pendingToolCalls.set(toolCallId, { name: tc.name, arguments: tc.arguments });

            console.log(`[retell-ws] Tool call: ${tc.name}(${tc.arguments})`);

            ws.send(
              JSON.stringify({
                response_type: 'tool_call_invocation',
                tool_call_id: toolCallId,
                name: tc.name,
                arguments: tc.arguments,
              })
            );
          }
        }
      }
    } catch (err) {
      console.error('[retell-ws] Groq API error:', err.message);

      ws.send(
        JSON.stringify({
          response_type: 'response',
          response_id,
          content: "I'm sorry, I'm having a brief technical issue. Could you please repeat that?",
          content_complete: true,
          end_call: false,
        })
      );
    }
  }

  // ── Handle tool call result ──

  async function handleToolResult(ws, responseId, toolCall, resultContent, transcript) {
    // Handle end_call — send farewell and hang up, no Groq continuation needed
    if (toolCall.name === 'end_call') {
      ws.send(JSON.stringify({
        response_type: 'response',
        response_id: responseId,
        content: 'Thank you for calling. Have a great day!',
        content_complete: true,
        end_call: true,
      }));
      return;
    }

    const messages = [{ role: 'system', content: systemPrompt }];

    if (transcript && transcript.length > 0) {
      for (const turn of transcript) {
        messages.push({
          role: turn.role === 'agent' ? 'assistant' : 'user',
          content: turn.content,
        });
      }
    }

    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `tool_${toolCall.name}`,
          type: 'function',
          function: { name: toolCall.name, arguments: toolCall.arguments },
        },
      ],
    });

    messages.push({
      role: 'tool',
      tool_call_id: `tool_${toolCall.name}`,
      content: resultContent || 'Action completed.',
    });

    try {
      const stream = await getGroq().chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        temperature: 0.3,
        max_tokens: 500,
      });

      for await (const chunk of stream) {
        if (ws.readyState !== ws.OPEN) break;

        const delta = chunk.choices?.[0]?.delta;
        const finishReason = chunk.choices?.[0]?.finish_reason;

        if (delta?.content) {
          ws.send(
            JSON.stringify({
              response_type: 'response',
              response_id: responseId,
              content: delta.content,
              content_complete: false,
              end_call: false,
            })
          );
        }

        if (finishReason === 'stop') {
          ws.send(
            JSON.stringify({
              response_type: 'response',
              response_id: responseId,
              content: '',
              content_complete: true,
              end_call: false,
            })
          );
        }
      }
    } catch (err) {
      console.error('[retell-ws] Groq API error (tool result):', err.message);
      ws.send(
        JSON.stringify({
          response_type: 'response',
          response_id: responseId,
          content: "I've completed that action. Is there anything else I can help you with?",
          content_complete: true,
          end_call: false,
        })
      );
    }
  }
});
