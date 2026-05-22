// ─── Translation via Claude ─────────────────────────────────────
// Mirrors the dashboard's /api/translate behaviour: a frozen system
// prompt (cached) and a fast model. Results are cached in-process so
// repeated phrases in a meeting aren't re-translated.

import Anthropic from '@anthropic-ai/sdk';

// Kept verbatim from the dashboard so live and recorded translations
// read the same. Frozen string → prompt caching reuses it across the
// many calls a single meeting generates.
const TRANSLATION_SYSTEM_PROMPT = `You are a professional real-time interpreter for live business meetings.

Your job: translate the user's text accurately and naturally into the target language.

Rules:
- Output ONLY the translation. No explanations, no alternatives, no notes, no quotation marks around the result.
- Preserve the speaker's tone, register, and level of formality.
- Translate idioms to their natural equivalent in the target language rather than word-for-word.
- Keep proper nouns, brand names, product names, and acronyms unchanged unless they have a well-known localized form.
- Keep numbers, dates, currencies, and units intact and correctly formatted for the target language.
- The input may be a partial or unfinished sentence captured live from speech — translate what is given without inventing a completion.
- If the input is already in the target language, return it unchanged.
- Never refuse: if the text is unclear, produce the best faithful translation you can.`;

// Language code → human-readable name (subset; extend as needed).
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic',
  hi: 'Hindi', ru: 'Russian', tr: 'Turkish', nl: 'Dutch', pl: 'Polish',
  sv: 'Swedish', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay',
  uk: 'Ukrainian', el: 'Greek', he: 'Hebrew', hu: 'Hungarian',
  fil: 'Filipino (Tagalog)', ceb: 'Cebuano',
};

const translationCache = new Map<string, string>();

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  if (!client) client = new Anthropic();
  return client;
}

function langName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}

/**
 * Translate `text` from `from` to `to`. Returns the translation, the
 * original (when from === to), or null on failure.
 */
export async function translate(text: string, from: string, to: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (from === to) return text;

  const cacheKey = `${from}|${to}|${trimmed.toLowerCase()}`;
  const cached = translationCache.get(cacheKey);
  if (cached) return cached;

  const model = process.env.TRANSLATION_MODEL || 'claude-haiku-4-5';

  try {
    const message = await getClient().messages.create({
      model,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: TRANSLATION_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Translate the following text from ${langName(from)} to ${langName(to)}:\n\n${trimmed}`,
        },
      ],
    });

    const translated = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (translated) {
      translationCache.set(cacheKey, translated);
      return translated;
    }
  } catch (err) {
    console.error('[translate] failed:', err);
  }
  return null;
}
