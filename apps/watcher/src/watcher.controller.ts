import { Controller, Get } from '@nestjs/common';
import { WatcherService } from './watcher.service';

@Controller()
export class WatcherController {
  constructor(private readonly watcherService: WatcherService) {}

  @Get()
  getHello(): string {
    return this.watcherService.getHello();
  }
}
