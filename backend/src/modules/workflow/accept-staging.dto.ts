import { IsUUID } from 'class-validator';

export class AcceptStagingDto {
  @IsUUID()
  moveId: string;

  @IsUUID()
  stationId: string;
}
