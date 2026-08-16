import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Deleting the account is irreversible and cascades to every row the user owns,
 * so it asks for the password rather than accepting a bearer token alone — a
 * token that leaked out of a tab should not be enough to erase the account.
 */
export class DeleteAccountDto {
  @IsString()
  @IsNotEmpty()
  password!: string;
}
