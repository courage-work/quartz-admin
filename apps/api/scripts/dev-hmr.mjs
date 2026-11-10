// 화면과 API를 한 프로세스·한 포트로 띄우는 개발 모드 (`pnpm dev:hmr`, TRD §2.2).
// API는 `nest start --watch`로 다시 시작하고, 화면은 API 안의 Next 개발 서버가 HMR로 바로 반영한다.
//
// 이미 셸에 있는 환경변수가 .env보다 우선한다(node --env-file-if-exists). 그래서 여기서 정한 값이 .env의 값을 이긴다.
// - QA_WEB_DEV=1: 화면을 Next 개발 서버로 서빙
// - QA_PUBLIC_URL: 화면과 API가 같은 포트이므로 기본은 http://localhost:<PORT>. 셸에서 지정하면 그 값을 쓴다
import { spawn } from 'node:child_process';

const port = process.env.PORT ?? '3000';
const env = {
  ...process.env,
  QA_WEB_DEV: '1',
  QA_PUBLIC_URL: process.env.QA_PUBLIC_URL ?? `http://localhost:${port}`,
};

const child = spawn('nest start --watch --exec "node --env-file-if-exists=.env"', {
  env,
  shell: true,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
