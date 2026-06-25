import { Injectable } from '@nestjs/common';

@Injectable()
export class WatcherService {
  getHello(): string {
    return 'Hello World!';
  }
}
