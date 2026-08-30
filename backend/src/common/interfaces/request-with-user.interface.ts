import { Request } from 'express';
import { AuthenticatedUser } from './authenticated-user.interface';

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}
