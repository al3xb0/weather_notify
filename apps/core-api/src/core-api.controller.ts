import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { CoreApiService } from './core-api.service';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: string;
}

@ApiTags('meta')
@Controller()
export class CoreApiController {
  constructor(private readonly coreApiService: CoreApiService) {}

  @Get()
  @ApiOkResponse({ type: String })
  getHello(): string {
    return this.coreApiService.getHello();
  }

  @Get('health')
  @ApiOkResponse({ type: HealthResponseDto })
  health(): HealthResponseDto {
    return { status: 'ok' };
  }
}
