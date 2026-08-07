import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerRecord } from './ledger.entity';
import { LedgerService } from './ledger.service';

@Module({
  imports: [TypeOrmModule.forFeature([LedgerRecord])],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
