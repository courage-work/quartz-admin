import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';

describe('AppModule', () => {
  it('DI 컨테이너가 초기화된다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(app.getHttpServer()).toBeDefined();
    await app.close();
  });
});
