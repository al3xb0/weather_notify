import { Controller, Get } from '@nestjs/common';
import { NotifierService } from './notifier.service';

@Controller()
export class NotifierController {
  constructor(private readonly notifierService: NotifierService) {}

  @Get()
  getHello(): string {
    return this.notifierService.getHello();
  }
}
