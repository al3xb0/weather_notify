import { Type } from 'class-transformer';
import { IsString, IsUrl, ValidateNested } from 'class-validator';

class PushKeysDto {
  @IsString()
  p256dh!: string;

  @IsString()
  auth!: string;
}

export class CreatePushSubscriptionDto {
  // Push services always issue https endpoints; restricting the scheme also
  // narrows the SSRF surface when the notifier POSTs to this URL.
  @IsUrl({ protocols: ['https'], require_protocol: true })
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}

export class DeletePushSubscriptionDto {
  @IsString()
  endpoint!: string;
}
