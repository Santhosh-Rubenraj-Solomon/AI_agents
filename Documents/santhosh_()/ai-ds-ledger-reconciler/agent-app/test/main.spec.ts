import { Logger, ValidationPipe } from '@nestjs/common';
import * as os from 'os';

/**
 * main.ts calls bootstrap() at import time, so we mock NestFactory and the
 * AppModule (which would otherwise connect to Postgres/Redis) and assert that
 * the bootstrap wires the app the way the rest of the suite assumes.
 */
const mockFakeApp = {
  enableShutdownHooks: jest.fn(),
  useGlobalPipes: jest.fn(),
  use: jest.fn(),
  listen: jest.fn().mockResolvedValue(undefined),
};
const mockCreate = jest.fn().mockResolvedValue(mockFakeApp);

jest.mock('@nestjs/core', () => ({ ...jest.requireActual('@nestjs/core'), NestFactory: { create: mockCreate } }));
jest.mock('../src/app.module', () => ({ AppModule: class AppModule {} }));

const flush = () => new Promise((r) => setImmediate(r));

async function loadMain() {
  jest.isolateModules(() => {
    jest.spyOn(require('@nestjs/common').Logger, 'log').mockImplementation(() => undefined);
    require('../src/main');
  });
  await flush();
}

describe('main.ts bootstrap', () => {
  const OLD_PORT = process.env.PORT;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (OLD_PORT === undefined) delete process.env.PORT;
    else process.env.PORT = OLD_PORT;
    jest.restoreAllMocks();
  });

  it('enables shutdown hooks, a strict global ValidationPipe and listens on 3000 by default', async () => {
    delete process.env.PORT;
    await loadMain();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockFakeApp.enableShutdownHooks).toHaveBeenCalled();
    const pipe = mockFakeApp.useGlobalPipes.mock.calls[0][0];
    // isolateModules loads a separate copy of @nestjs/common, so compare by name.
    expect(pipe.constructor.name).toBe(ValidationPipe.name);
    expect((pipe as any).validatorOptions).toMatchObject({ whitelist: true, forbidNonWhitelisted: true });
    expect((pipe as any).isTransformEnabled).toBe(true);
    expect(mockFakeApp.listen).toHaveBeenCalledWith(3000);
  });

  it('honours PORT', async () => {
    process.env.PORT = '4321';
    await loadMain();
    expect(mockFakeApp.listen).toHaveBeenCalledWith(4321);
  });

  it('middleware stamps X-Instance-Name with the hostname and calls next()', async () => {
    await loadMain();
    const mw = mockFakeApp.use.mock.calls[0][0];
    const res = { setHeader: jest.fn() };
    const next = jest.fn();
    mw({ method: 'GET', originalUrl: '/health' }, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-Instance-Name', os.hostname());
    expect(next).toHaveBeenCalled();
  });
});
