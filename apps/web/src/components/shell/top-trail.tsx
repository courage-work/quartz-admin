'use client';

import { createContext } from 'react';

/**
 * 헤더(상단 바)에서 경로를 그릴 자리. 레이아웃이 요소를 넣어 두면 `PageHeader`가 포털로 경로를 그린다.
 * 상단 바는 스크롤해도 붙어 있으므로, 제목이 화면 밖으로 나가도 지금 어느 화면인지 보인다.
 */
export const TopTrailSlotContext = createContext<HTMLElement | null>(null);
