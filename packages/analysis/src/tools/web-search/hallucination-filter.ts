/**
 * Stateful cross-chunk filter that strips LLM-emitted pseudo tool-call
 * syntax from a streaming text channel.
 *
 * Why: when a chat.completions-only vendor (DeepSeek / Qwen / Kimi / 小米)
 * gets a system prompt that says "use web_search" but no tool is wired,
 * the model emits the tool-call syntax it learned at training time *as
 * text* — `<function><invoke name="web_search">…</invoke></function>`,
 * `<function_calls>…`, raw `{thoughts: …, command: "web_search", …}` JSON,
 * `搜索 1: web_search("…")` pseudo-code, etc. These bytes flow straight
 * through `chunk.choices[0].delta.content` and land in the SSE
 * `report_chunk` stream → user UI shows garbage.
 *
 * Our defense is layered: the prompt branch (freshness.ts) tells the
 * model not to do this; this filter is the belt-and-suspenders that
 * removes it if the model ignores the instruction (newer fine-tunes
 * tend to leak novel formats).
 *
 * Implementation: small state machine — pass-through until we see an
 * opener; buffer until matching closer; if we partial-match across chunks,
 * keep buffering. On any unrecoverable mismatch we flush the buffer back
 * verbatim so we never silently swallow real content.
 */

interface PendingRegion {
  /** Bytes accumulated since the suspected opener. */
  buffer: string;
  /** Regex that closes this region. */
  closer: RegExp;
  /** Hard cap so a runaway never grows the buffer forever. */
  maxBytes: number;
}

const REGION_OPENERS: Array<{
  open: RegExp;
  closer: RegExp;
  maxBytes: number;
}> = [
  // <function_calls>…</function_calls>  (Anthropic-style XML)
  {
    open: /<function_calls\b[^>]*>/i,
    closer: /<\/function_calls\s*>/i,
    maxBytes: 8_000,
  },
  // <function>…</function>
  {
    open: /<function\b[^>]*>/i,
    closer: /<\/function\s*>/i,
    maxBytes: 8_000,
  },
  // <invoke …>…</invoke>
  {
    open: /<invoke\b[^>]*>/i,
    closer: /<\/invoke\s*>/i,
    maxBytes: 8_000,
  },
];

/**
 * Pseudo-JSON tool plans the model invents when no tool is wired. We
 * scrub these line-wise (single-line replace) on each emitted slice —
 * stateless, no buffering, since they don't span chunks visibly.
 */
const INLINE_NOISE_PATTERNS: RegExp[] = [
  // {"thoughts": "...", "command": "web_search", "keywords": [...]}
  /\{\s*["']?thoughts["']?\s*:[\s\S]{0,1500}?\}/g,
  // web_search("query string", count)
  /\bweb_search\s*\(\s*["'][\s\S]{0,400}?["']\s*(?:,\s*\d+\s*)?\)/g,
  // 搜索 1: ...
  /^\s*搜索\s*\d+\s*[:：].*$/gm,
  // 完成 / 进行中 status lines that follow pseudo plans
  /^\s*(完成|进行中|已完成|开始)\s*$/gm,
];

/**
 * Heuristic: shortest prefix length we need before we can decide whether
 * a `<` byte is the start of a known opener. Any `<` is "maybe an opener"
 * until we see at least this many bytes after it.
 */
const MIN_OPEN_PROBE_LEN = 16;

export class HallucinationFilter {
  private carry = '';
  private pending: PendingRegion | null = null;
  private suppressed = 0;

  /** Total bytes the filter has dropped from the stream. */
  get suppressedBytes(): number {
    return this.suppressed;
  }

  /**
   * Feed one delta. Returns the cleaned text that's safe to forward.
   * The caller streams the return value verbatim; anything held back
   * stays in internal state until `feed()` or `flush()` is next called.
   */
  feed(chunk: string): string {
    if (!chunk) return '';
    let work = this.carry + chunk;
    this.carry = '';
    let out = '';

    while (work.length > 0) {
      if (this.pending) {
        const match = this.pending.closer.exec(work);
        if (match) {
          // Whole region eaten.
          const consumed = match.index + match[0].length;
          this.suppressed += this.pending.buffer.length + consumed;
          this.pending = null;
          work = work.slice(consumed);
          continue;
        }
        // No closer yet — buffer it.
        this.pending.buffer += work;
        if (this.pending.buffer.length > this.pending.maxBytes) {
          // Runaway: flush as-is rather than swallow real content.
          out += this.pending.buffer;
          this.pending = null;
        }
        work = '';
        break;
      }

      const nextOpen = findNextOpener(work);
      if (!nextOpen) {
        // Hold a tail back in case an opener is split across chunks.
        if (work.length > MIN_OPEN_PROBE_LEN && work.endsWith('<')) {
          this.carry = '<';
          out += stripInlineNoise(work.slice(0, -1));
        } else if (work.length <= MIN_OPEN_PROBE_LEN && work.includes('<')) {
          this.carry = work;
        } else {
          out += stripInlineNoise(work);
        }
        work = '';
        break;
      }

      // Emit pre-opener text after inline scrubbing.
      out += stripInlineNoise(work.slice(0, nextOpen.start));
      work = work.slice(nextOpen.end);
      this.pending = {
        buffer: '',
        closer: nextOpen.closer,
        maxBytes: nextOpen.maxBytes,
      };
    }

    return out;
  }

  /**
   * Stream ended. If we're mid-region we treat the unterminated opener
   * as a hallucination and drop it; if we have only a carry probe, flush.
   */
  flush(): string {
    let out = '';
    if (this.carry) {
      out += stripInlineNoise(this.carry);
      this.carry = '';
    }
    if (this.pending) {
      this.suppressed += this.pending.buffer.length;
      this.pending = null;
    }
    return out;
  }
}

interface OpenerHit {
  start: number;
  end: number;
  closer: RegExp;
  maxBytes: number;
}

function findNextOpener(s: string): OpenerHit | null {
  let best: OpenerHit | null = null;
  for (const r of REGION_OPENERS) {
    r.open.lastIndex = 0;
    const m = r.open.exec(s);
    if (!m) continue;
    const hit: OpenerHit = {
      start: m.index,
      end: m.index + m[0].length,
      closer: new RegExp(r.closer.source, r.closer.flags),
      maxBytes: r.maxBytes,
    };
    if (!best || hit.start < best.start) best = hit;
  }
  return best;
}

function stripInlineNoise(s: string): string {
  let out = s;
  for (const p of INLINE_NOISE_PATTERNS) {
    out = out.replace(p, '');
  }
  return out;
}
