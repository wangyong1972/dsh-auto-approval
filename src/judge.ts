import type { JudgeVerdict } from './types.ts';

/**
 * Call LM Studio to judge whether a permission request is safe.
 *
 * Uses few-shot prompting with Gemma 4 4B: explicit SAFE and NOT_SAFE
 * examples calibrate the model (tested: 21/22 correct, ~200ms latency).
 *
 * Gemma escapes underscores in output (`NOT\_SAFE`), so the parser
 * normalizes markdown escapes before classifying.
 */
export async function judge(
  toolName: string,
  args: string | undefined,
  reason: string | undefined,
  baseUrl: string,
  modelName: string,
  signal?: AbortSignal,
): Promise<JudgeVerdict | undefined> {
  const operation = buildDescription(toolName, args, reason);

  const fewShot = [
    'Here are examples of SAFE operations:',
    '- write file /home/user/project/src/index.ts',
    '- read file /home/user/project/package.json',
    '- run command git status',
    '- run command npm install express',
    '- run command pnpm run build',
    '- run command curl https://api.example.com',
    '',
    'Here are examples of NOT_SAFE operations:',
    '- read file /etc/passwd',
    '- read file /etc/shadow',
    '- read file /home/user/.ssh/id_rsa',
    '- write file /etc/hosts',
    '- write file /home/user/.ssh/config',
    '- run command sudo rm -rf /',
    '- run command rm -rf /',
    '- read file /home/user/.ssh/authorized_keys',
  ].join('\n');

  const prompt = [
    fewShot,
    '',
    `Classify this operation: ${operation}`,
    '',
    'SAFE or NOT_SAFE? Reply with exactly one word.',
  ].join('\n');

  const body = {
    model: modelName,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 20,
  };

  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (signal !== undefined) {
    init.signal = signal;
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, init);

    if (!response.ok) {
      console.error(`[auto-approval] LM Studio returned ${response.status}`);
      return undefined;
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };

    const rawContent = data?.choices?.[0]?.message?.content ?? '';
    if (!rawContent.trim()) {
      console.error('[auto-approval] Empty LM Studio response');
      return undefined;
    }

    // Normalize: strip markdown escapes (Gemma outputs NOT\_SAFE) and backticks
    const raw = rawContent.replace(/\\_/g, '_').replace(/`/g, '').trim().toUpperCase();

    // Classify the response
    if (raw.startsWith('NOT_SAFE') || raw.includes('NOT_SAFE') || raw.includes('UNSAFE')) {
      return { safe: false, confidence: 0.85 };
    }
    if (raw === 'SAFE' || raw.startsWith('SAFE')) {
      return { safe: true, confidence: 0.85 };
    }

    console.error('[auto-approval] Unrecognized response:', raw);
    return undefined;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return undefined;
    }
    console.error('[auto-approval] Judge call failed:', err);
    return undefined;
  }
}

/**
 * Build a short flat description of the operation from available information.
 */
function buildDescription(
  toolName: string,
  args: string | undefined,
  reason: string | undefined,
): string {
  const parts: string[] = [toolName];

  if (args) {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const filePath = parsed.file_path ?? parsed.target ?? parsed.path;
      const command = parsed.command;
      if (typeof filePath === 'string') parts.push(`file ${String(filePath)}`);
      if (typeof command === 'string') parts.push(`command "${command}"`);
    } catch {
      parts.push(args.slice(0, 120));
    }
  }

  if (reason) {
    parts.push(`// ${reason.slice(0, 80)}`);
  }

  return parts.join(' ');
}