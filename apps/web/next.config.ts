import type { NextConfig } from 'next';

// 정적 export(SPA)로 빌드하고 NestJS가 같은 오리진에서 서빙한다 (TRD §2.2)
const nextConfig: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
