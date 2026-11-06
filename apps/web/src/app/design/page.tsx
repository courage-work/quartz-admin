import type { Metadata } from 'next';

import { DesignShowcase } from './showcase';

export const metadata: Metadata = {
  title: '디자인 시스템 · quartz-admin',
};

/** 디자인 시스템 쇼케이스 (docs/DESIGN.md). 화면을 만들기 전에 토큰과 컴포넌트를 여기서 확인한다. */
export default function DesignPage() {
  return <DesignShowcase />;
}
