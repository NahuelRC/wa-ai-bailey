import fetch from 'node-fetch';
import { cfg } from './config.js';
import { loadSystemPrompt, ensureSystemPromptInitialized } from './promptStore.js';
import { appendConversationTurn, getRecentConversationHistoryForUser } from './conversationStore.js';
import { defaultSystemPrompt } from './prompts/defaultSystemPrompt.js';
import { getPrimaryUserId } from './userStore.js';

const welcomed = new Set<string>();
const cachedPrompts = new Map<string, string>();
let primaryUserIdCache: string | null | undefined;

async function resolveUserId(preferred?: string): Promise<string> {
  const trimmed = preferred?.trim();
  if (trimmed) return trimmed;
  if (!primaryUserIdCache) {
    primaryUserIdCache = await getPrimaryUserId();
  }
  return primaryUserIdCache ?? 'global';
}

async function getSystemPrompt(userId?: string): Promise<string> {
  const promptUserId = await resolveUserId(userId);
  const cached = cachedPrompts.get(promptUserId);
  if (cached) return cached;
  try {
    await ensureSystemPromptInitialized(promptUserId);
    const prompt = await loadSystemPrompt(promptUserId);
    cachedPrompts.set(promptUserId, prompt);
    return prompt;
  } catch (err) {
    console.error('Usando prompt por defecto por error al cargar desde Mongo:', err);
    cachedPrompts.set(promptUserId, defaultSystemPrompt);
    return defaultSystemPrompt;
  }
}

export function invalidateSystemPromptCache(userId?: string) {
  if (userId?.trim()) {
    cachedPrompts.delete(userId.trim());
  } else {
    cachedPrompts.clear();
  }
}

async function fetchWithTimeout(url: string, opts: any = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// Normalizador simple
function norm(s: string) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detecta el mensaje de cierre (por si el BE lo quisiera usar)
export function isClosingAgentText(s: string): boolean {
  const t = norm(s);
  return t.includes('tu pedido ha sido registrado');
}

export type AiMedia = { url: string; caption?: string };
export type AiOrder = {
  nombre?: string;
  producto?: 'capsulas' | 'semillas' | 'gotas' | string;
  cantidad?: number | string;
  total_ars?: number | string;
  direccion?: string;
  cp?: string;
  ciudad?: string;
};

export type AiEnvelope = {
  text: string;
  media?: AiMedia[];
  order?: AiOrder; // ← opcional: sólo cuando se cierra la compra
};

export async function aiReply(userText: string, phone: string, history: string = '', userId?: string): Promise<AiEnvelope> {
  const phoneKey = phone?.trim() ?? '';
  const sanitizedUserText = typeof userText === 'string' ? userText.trim() : '';
  const effectiveUserText = sanitizedUserText || userText || '';

  const resolvedUserId = await resolveUserId(userId);
  const welcomeKey = `${resolvedUserId}::${phoneKey}`;

  const previousTurns = phoneKey
    ? await getRecentConversationHistoryForUser(resolvedUserId, phoneKey, 12)
    : [];
  if (phoneKey && previousTurns.length > 0 && !welcomed.has(welcomeKey)) {
    welcomed.add(welcomeKey);
  }

  let firstTurn = phoneKey ? !welcomed.has(welcomeKey) : true;
  if (phoneKey && previousTurns.length > 0) {
    firstTurn = false;
  }

  const dbHistory = previousTurns.length
    ? previousTurns.map((turn) => `U: ${turn.userText}\nA: ${turn.aiText}`).join('\n')
    : '';
  const historyForPrompt = history?.trim() ? history : dbHistory;

  let envelope: AiEnvelope = {
    text: 'Tuve un problema técnico para generar la respuesta. ¿Podés repetir o reformular tu consulta?',
  };

  if (!cfg.OPENAI_API_KEY) {
    envelope = { text: 'Soy tu asistente. Configurá OPENAI_API_KEY para respuestas mejoradas.' };
  } else {
    const system = await getSystemPrompt(resolvedUserId);
    const meta = `Canal: WhatsApp. Limita a ~4-6 líneas salvo que pidan detalle.
Contexto:
- first_turn: ${firstTurn ? 'yes' : 'no'}
- Historial breve (U/A alternado):
${historyForPrompt || '(sin historial)'}
`;

    const body = {
      model: cfg.OPENAI_MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'system', content: meta },
        { role: 'user', content: effectiveUserText }
      ]
    };

    try {
      const res = await fetchWithTimeout(
        `${cfg.OPENAI_BASE_URL}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        },
        20000
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error('OpenAI error:', res.status, errText);
        envelope = { text: 'Ahora mismo no puedo responder con IA, pero puedo ayudarte igual. ¿Qué necesitás saber?' };
      } else {
        const json: any = await res.json().catch(() => null);
        const raw = json?.choices?.[0]?.message?.content?.trim() || '';

        let parsedEnvelope: AiEnvelope | null = null;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.text === 'string') {
            parsedEnvelope = {
              text: parsed.text,
              media: Array.isArray(parsed.media)
                ? parsed.media.filter((m: any) => m && typeof m.url === 'string' && m.url.trim())
                : undefined,
            };
            if (parsed.order && typeof parsed.order === 'object') {
              parsedEnvelope.order = parsed.order as AiOrder;
            }
          }
        } catch {
          // cae a fallback
        }

        if (parsedEnvelope) {
          envelope = parsedEnvelope;
        } else {
          const fallbackText = raw || '¿En qué puedo ayudarte?';
          envelope = { text: fallbackText };
        }
      }
    } catch (e: any) {
      console.error('Error llamando a OpenAI:', e?.message || e);
      envelope = { text: 'Tuve un problema técnico para generar la respuesta. ¿Podés repetir o reformular tu consulta?' };
    }
  }

  if (firstTurn && phoneKey) {
    welcomed.add(welcomeKey);
  }

  if (phoneKey) {
    await appendConversationTurn(resolvedUserId, phoneKey, {
      userText: effectiveUserText,
      aiText: envelope.text,
      aiMedia: envelope.media?.map((m) => ({ url: m.url, caption: m.caption })),
      aiOrder: envelope.order ? { ...envelope.order } : undefined,
      createdAt: new Date(),
    });
  }

  return envelope;
}
