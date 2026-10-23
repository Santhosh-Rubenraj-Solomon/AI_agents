import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as os from 'os';
import request from 'supertest';
import { AppController } from '../src/app.controller';

describe('AppController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [AppController] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it('GET / identifies the service and serving instance', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.body).toEqual({
      service: 'ai-ds-ledger-reconciler',
      instance: os.hostname(),
      ts: expect.any(String),
    });
    expect(new Date(res.body.ts).toISOString()).toBe(res.body.ts);
  });

  it('GET /health returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', instance: os.hostname() });
  });

  it('unknown routes 404', async () => {
    await request(app.getHttpServer()).get('/nope').expect(404);
  });
});
