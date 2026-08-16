import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: string;
}

@ApiTags('meta')
@Controller()
export class CoreApiController {
  /**
   * Liveness for the public port. Answers as long as the process is up:
   * dependencies are reported on the metrics port's `/ready`, because a
   * restart cannot fix a database that is down but rerouting traffic can.
   */
  @Get('health')
  @ApiOkResponse({ type: HealthResponseDto })
  health(): HealthResponseDto {
    return { status: 'ok' };
  }
}
