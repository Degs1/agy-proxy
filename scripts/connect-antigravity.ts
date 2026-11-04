import readline from 'readline';
import { exec } from 'child_process';
import { ObjectId } from 'mongodb';
import { getDatabase, closeDatabaseConnection } from '../src/lib/db/client';
import { COLLECTIONS, ProjectDocument } from '../src/lib/db/schema';
import {
  generatePkce,
  generateState,
  buildAuthorizationUrl,
  completeOAuthFlow,
  oauthSessionStore,
} from '../src/lib/antigravity/oauth';
import { startLocalOAuthListener, stopLocalOAuthListener } from '../src/lib/antigravity/local-server';

function openBrowser(url: string) {
  const platform = process.platform;
  let command = '';

  if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, () => {});
}

async function main() {
  const db = await getDatabase();
  let projectIdStr = process.argv[2];

  if (!projectIdStr) {
    const projects = await db
      .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
      .find({ status: 'active' })
      .limit(10)
      .toArray();

    if (projects.length === 0) {
      console.error('Tidak ada project aktif di database. Buat project terlebih dahulu di dashboard.');
      process.exit(1);
    }

    if (projects.length === 1) {
      projectIdStr = projects[0]._id!.toString();
      console.log(`Menggunakan project: ${projects[0].name} (${projectIdStr})`);
    } else {
      console.log('Daftar Project:');
      projects.forEach((p, i) => console.log(`  [${i + 1}] ${p.name} (${p._id})`));
      console.log('\nGunakan: npx tsx scripts/connect-antigravity.ts <PROJECT_ID>');
      process.exit(1);
    }
  }

  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();

  oauthSessionStore.set(state, {
    state,
    codeVerifier,
    projectId: projectIdStr,
    createdAt: Date.now(),
    status: 'pending',
  });

  const authUrl = buildAuthorizationUrl(state, codeChallenge);

  console.log('\n======================================================');
  console.log('   GOOGLE ANTIGRAVITY OAUTH AUTHORIZATION FLOW');
  console.log('======================================================\n');
  console.log('1. Membuka browser untuk login Google Antigravity...');
  console.log(`2. Listener callback lokal berjalan di port 51121.`);
  console.log('\nJika browser tidak otomatis terbuka, buka tautan berikut:');
  console.log(`\n${authUrl}\n`);

  await startLocalOAuthListener();
  openBrowser(authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptPromise = new Promise<string>((resolve) => {
    rl.question(
      'Atau tempelkan kode / URL redirect di sini jika callback lokal tidak terpanggil: ',
      (answer) => {
        resolve(answer.trim());
      }
    );
  });

  // Poll session state or wait for manual input
  const pollPromise = new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const session = oauthSessionStore.get(state);
      if (session && session.status === 'completed') {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
  });

  const raceResult = await Promise.race([
    promptPromise.then((input) => ({ type: 'manual' as const, input })),
    pollPromise.then(() => ({ type: 'auto' as const })),
  ]);

  rl.close();

  if (raceResult.type === 'manual' && raceResult.input) {
    let input = raceResult.input;
    if (input.includes('code=')) {
      try {
        const u = new URL(input);
        input = u.searchParams.get('code') || input;
      } catch {}
    }

    console.log('\nMemproses kode otentikasi manual...');
    const cred = await completeOAuthFlow(db, {
      code: input,
      codeVerifier,
      projectId: projectIdStr,
    });
    console.log(`✓ Kredensial berhasil disimpan! ID: ${cred._id}`);
  } else {
    console.log('\n✓ Autentikasi otomatis via http://localhost:51121 berhasil!');
  }

  stopLocalOAuthListener();
  await closeDatabaseConnection();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nError:', err);
  stopLocalOAuthListener();
  await closeDatabaseConnection().catch(() => {});
  process.exit(1);
});

