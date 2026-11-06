import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';
/** 개발 서버(`next dev`, 포트 3001)가 `/api`를 넘길 API 주소 */
const apiUrl = process.env.QA_API_URL ?? 'http://localhost:3000';

// 정적 export(SPA)로 빌드하고 NestJS가 같은 오리진에서 서빙한다 (TRD §2.2)
const nextConfig: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  // 개발 중에는 웹 개발 서버가 API를 프록시해 같은 오리진처럼 동작시킨다.
  // 이때 API의 QA_PUBLIC_URL은 http://localhost:3001이어야 CSRF Origin 검사를 통과한다
  ...(isDev
    ? {
        rewrites: () =>
          Promise.resolve([{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]),
      }
    : {}),
};

export default nextConfig;
