import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { API_PREFIX, APP_NAME } from '@qa/shared';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
app.setGlobalPrefix(API_PREFIX);
app.enableShutdownHooks();

const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
Logger.log(`${APP_NAME} API listening on :${port}/${API_PREFIX}`, 'Bootstrap');
