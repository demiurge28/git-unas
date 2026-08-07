import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../src/middleware/requireAuth';

describe('requireAuth middleware', () => {
  it('calls next() when the session has a userId', () => {
    const next = jest.fn() as unknown as NextFunction;
    const req = { session: { userId: 'user-1' } } as unknown as Request;
    const res = {} as Response;
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('responds 401 when the session has no userId', () => {
    const next = jest.fn() as unknown as NextFunction;
    const json = jest.fn();
    const status = jest.fn(() => ({ json })) as unknown as Response['status'];
    const req = { session: {} } as unknown as Request;
    const res = { status } as unknown as Response;
    requireAuth(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when there is no session at all', () => {
    const next = jest.fn() as unknown as NextFunction;
    const json = jest.fn();
    const status = jest.fn(() => ({ json })) as unknown as Response['status'];
    const req = {} as unknown as Request;
    const res = { status } as unknown as Response;
    requireAuth(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
