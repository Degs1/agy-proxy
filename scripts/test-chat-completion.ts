import crypto from 'crypto';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let apiKey = process.env.GATEWAY_API_KEY || '';
  let model = process.env.GATEWAY_MODEL || 'gemini-default';
  let baseUrl = process.env.GATEWAY_URL || 'http://localhost:3000';
  let customPrompt = 'Halo! Ceritakan dalam 1 kalimat siapa kamu dan model apa yang sedang berjalan.';
  let mode: 'both' | 'stream' | 'nonstream' = 'both';

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--key' && args[i + 1]) {
      apiKey = args[++i];
    } else if (arg === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (arg === '--url' && args[i + 1]) {
      baseUrl = args[++i];
    } else if (arg === '--prompt' && args[i + 1]) {
      customPrompt = args[++i];
    } else if (arg === '--stream') {
      mode = 'stream';
    } else if (arg === '--nonstream') {
      mode = 'nonstream';
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional[0] && !apiKey) {
    apiKey = positional[0];
  }
  if (positional[1]) {
    model = positional[1];
  }
  if (positional[2]) {
    baseUrl = positional[2];
  }

  // Strip trailing slashes from baseUrl
  baseUrl = baseUrl.replace(/\/+$/, '');

  return { apiKey, model, baseUrl, customPrompt, mode };
}

async function testNonStream(baseUrl: string, apiKey: string, model: string, prompt: string) {
  console.log('\n============================================================');
  console.log('  1. TESTING NON-STREAM CHAT COMPLETION (stream: false)');
  console.log('============================================================');

  const endpoint = `${baseUrl}/v1/chat/completions`;
  const idempotencyKey = crypto.randomUUID();

  const payload = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful AI assistant.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    stream: false,
  };

  console.log(`Endpoint:        POST ${endpoint}`);
  console.log(`Model Alias:     ${model}`);
  console.log(`Idempotency-Key: ${idempotencyKey}`);
  console.log(`Prompt:          "${prompt}"\n`);
  console.log('Mengirim request...');

  const startTime = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const durationMs = Date.now() - startTime;
  const status = res.status;
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`\n❌ REQUEST GAGAL (HTTP ${status}) dalam ${durationMs}ms:`);
    try {
      const errJson = JSON.parse(errorBody);
      console.error(JSON.stringify(errJson, null, 2));
    } catch {
      console.error(errorBody);
    }
    explainError(status);
    return false;
  }

  const data = (await res.json()) as ChatCompletionResponse;

  console.log(`\n✓ Sukses (HTTP 200 OK) dalam ${durationMs}ms!`);
  console.log('------------------------------------------------------------');
  console.log(`ID Response:     ${data.id}`);
  console.log(`Model:           ${data.model}`);
  console.log(`Finish Reason:   ${data.choices[0]?.finish_reason}`);
  if (data.usage) {
    console.log(
      `Token Usage:     Prompt: ${data.usage.prompt_tokens} | Completion: ${data.usage.completion_tokens} | Total: ${data.usage.total_tokens}`
    );
  }
  console.log('------------------------------------------------------------');
  console.log('Jawaban Model:\n');
  console.log(data.choices[0]?.message?.content);
  console.log('------------------------------------------------------------\n');

  return true;
}

async function testStream(baseUrl: string, apiKey: string, model: string, prompt: string) {
  console.log('\n============================================================');
  console.log('  2. TESTING STREAMING CHAT COMPLETION (stream: true)');
  console.log('============================================================');

  const endpoint = `${baseUrl}/v1/chat/completions`;
  const idempotencyKey = crypto.randomUUID();

  const payload = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful AI assistant.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    stream: true,
  };

  console.log(`Endpoint:        POST ${endpoint}`);
  console.log(`Model Alias:     ${model}`);
  console.log(`Idempotency-Key: ${idempotencyKey}`);
  console.log(`Prompt:          "${prompt}"\n`);
  console.log('Memulai streaming SSE...\n');
  console.log('------------------------------------------------------------');

  const startTime = Date.now();
  let firstTokenTime: number | null = null;
  let chunkCount = 0;
  let fullText = '';
  let finalUsage: ChatCompletionChunk['usage'] = null;
  let finishReason: string | null = null;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const durationHeaders = Date.now() - startTime;

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`\n❌ REQUEST GAGAL (HTTP ${res.status}):`);
    try {
      console.error(JSON.stringify(JSON.parse(errorBody), null, 2));
    } catch {
      console.error(errorBody);
    }
    explainError(res.status);
    return false;
  }

  if (!res.body) {
    console.error('❌ Response body kosong');
    return false;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === '[DONE]') {
        continue;
      }

      try {
        const chunk = JSON.parse(jsonStr) as ChatCompletionChunk;
        chunkCount++;

        if (firstTokenTime === null) {
          firstTokenTime = Date.now() - startTime;
        }

        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          process.stdout.write(delta);
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
      } catch {
        // Skip unparseable heartbeat or malformed SSE comments
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  console.log('\n------------------------------------------------------------');
  console.log(`✓ Stream Selesai!`);
  console.log(`Total Chunks:    ${chunkCount}`);
  console.log(`Time to First:   ${firstTokenTime !== null ? `${firstTokenTime}ms` : 'N/A'}`);
  console.log(`Total Waktu:     ${totalDuration}ms`);
  console.log(`Finish Reason:   ${finishReason || 'stop'}`);
  if (finalUsage) {
    console.log(
      `Token Usage:     Prompt: ${finalUsage.prompt_tokens} | Completion: ${finalUsage.completion_tokens} | Total: ${finalUsage.total_tokens}`
    );
  }
  console.log('------------------------------------------------------------\n');

  return true;
}

function explainError(status: number) {
  console.log('\n💡 Tips Diagnostik Error:');
  if (status === 401) {
    console.log('   - Periksa API key Anda (pastikan dimulai dengan "agw_...").');
    console.log('   - Pastikan key belum dicabut (status: active).');
  } else if (status === 404) {
    console.log('   - Model alias tidak ditemukan di dalam project API key tersebut.');
    console.log('   - Buka admin dashboard > Project > Tab "Model Aliases", pastikan alias terdaftar.');
  } else if (status === 403) {
    console.log('   - Model alias atau project sedang dinonaktifkan (status: disabled).');
  } else if (status === 503) {
    console.log('   - Kredensial provider yang diikat ke alias ini nonaktif atau tidak valid.');
    console.log('   - Atau rate limiter limiter_unavailable.');
  } else if (status === 429) {
    console.log('   - Request melebihi batas RPM atau Concurrency Limit project.');
  }
}

async function main() {
  const { apiKey, model, baseUrl, customPrompt, mode } = parseArgs();

  console.log('\n======================================================');
  console.log('       ANTIGRAVITY GATEWAY - OPENAI CHAT TESTER        ');
  console.log('======================================================');

  if (!apiKey) {
    console.error('\n❌ ERROR: API Key belum diberikan!');
    console.log('\nCara Menjalankan:');
    console.log('  npx tsx scripts/test-chat-completion.ts <API_KEY> [MODEL_ALIAS] [BASE_URL]');
    console.log('\nContoh:');
    console.log('  npx tsx scripts/test-chat-completion.ts agw_abc123... gemini-default');
    console.log('  npx tsx scripts/test-chat-completion.ts agw_abc123... claude-3-5-sonnet');
    console.log('\nAtau set environment variable:');
    console.log('  $env:GATEWAY_API_KEY="agw_abc123..."');
    console.log('  npx tsx scripts/test-chat-completion.ts\n');
    process.exit(1);
  }

  let successNonStream = true;
  let successStream = true;

  if (mode === 'both' || mode === 'nonstream') {
    successNonStream = await testNonStream(baseUrl, apiKey, model, customPrompt);
  }

  if (mode === 'both' || mode === 'stream') {
    successStream = await testStream(baseUrl, apiKey, model, customPrompt);
  }

  if (successNonStream && successStream) {
    console.log('🎉 SEMUA PENGUJIAN GATEWAY BERHASIL DENGAN SEMPURNA!\n');
    process.exit(0);
  } else {
    console.error('⚠️  Ada pengujian yang gagal. Periksa log diagnostik di atas.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal Error:', err);
  process.exit(1);
});

