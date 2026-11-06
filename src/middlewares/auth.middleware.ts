
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface TokenPayload {
  userId: number;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authorization = req.headers.authorization;
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Debes iniciar sesión.'
    });
  }

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error('Falta configurar JWT_SECRET');

    return res.status(500).json({
      success: false,
      message: 'Error de configuración del servidor.'
    });
  }

  try {
    const payload = jwt.verify(token, secret, {
      issuer: 'docuflow-api',
      audience: 'docuflow-client'
    }) as TokenPayload;

    res.locals.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: 'La sesión es inválida o ha expirado.'
    });
  }
}