import { Controller, Get } from '@nestjs/common';
import * as os from 'os';

/**
 * Lightweight endpoints used to demonstrate the load balancer. Hit GET /
 * repeatedly through nginx and watch `instance` rotate across the 3 replicas.
 */
@Controller()
export class AppController {
  private readonly instance = os.hostname();

  @Get()
  root() {
    return {
      service: 'ai-ds-ledger-reconciler',
      instance: this.instance,
      ts: new Date().toISOString(),
    };
  }

  @Get('health')
  health() {
    return { status: 'ok', instance: this.instance };
  }
}
