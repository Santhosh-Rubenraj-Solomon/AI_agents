import { Module } from '@nestjs/common';
import { LockService } from './lock.service';
import { DistributedLockGuard } from './distributed-lock.guard';

@Module({
  providers: [LockService, DistributedLockGuard],
  exports: [LockService, DistributedLockGuard],
})
export class LockModule {}
