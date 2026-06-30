import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

/** Shape of the incoming vendor webhook: { txId, amount, vendorStatus }. */
export class ReconcileDto {
  @IsString()
  @IsNotEmpty()
  txId!: string;

  @IsNumber()
  amount!: number;

  @IsString()
  @IsNotEmpty()
  vendorStatus!: string;
}
