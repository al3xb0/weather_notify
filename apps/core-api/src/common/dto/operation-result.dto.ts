import { ApiProperty } from '@nestjs/swagger';

/** Response of a single-resource delete: the id that was removed. */
export class IdResultDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
}

/** Response of a bulk delete: how many rows were removed. */
export class CountResultDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  count!: number;
}

/** Response of an action with nothing meaningful to return. */
export class SuccessResultDto {
  @ApiProperty()
  success!: boolean;
}
