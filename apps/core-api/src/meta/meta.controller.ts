import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { API_LIMITS } from './limits';
import { MetaResponseDto } from './meta.dto';

@ApiTags('meta')
@Controller('meta')
export class MetaController {
  /** Public on purpose: the sign-up flow needs the limits before a token. */
  @Get()
  @ApiOkResponse({ type: MetaResponseDto })
  get(): MetaResponseDto {
    return { limits: { ...API_LIMITS } };
  }
}
