/** 현재 시각(epoch ms). 테스트에서 시간을 움직이기 위해 DI로 주입한다 */
export type Clock = () => number;

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = () => Date.now();
