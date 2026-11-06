
import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../config/database';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  status: 'active' | 'suspended';
}

function createToken(userId: number): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('Falta configurar JWT_SECRET');
  }

  return jwt.sign({ userId }, secret, {
    expiresIn: '1h',
    issuer: 'docuflow-api',
    audience: 'docuflow-client'
  });
}

export async function register(req: Request, res: Response) {
  const name = typeof req.body.name === 'string'
    ? req.body.name.trim()
    : '';

  const email = typeof req.body.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';

  const password = typeof req.body.password === 'string'
    ? req.body.password
    : '';

  if (!name || name.length > 120) {
    return res.status(400).json({
      success: false,
      message: 'Ingresa un nombre válido.'
    });
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 190
  ) {
    return res.status(400).json({
      success: false,
      message: 'Ingresa un correo válido.'
    });
  }

  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({
      success: false,
      message: 'La contraseña debe tener entre 8 y 72 caracteres.'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [existing] = await connection.execute<UserRow[]>(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    if (existing.length > 0) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: 'Este correo ya está registrado.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [userResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO users (name, email, password_hash)
       VALUES (?, ?, ?)`,
      [name, email, passwordHash]
    );

    const [plans] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM plans
       WHERE code = 'free' AND active = TRUE
       LIMIT 1`
    );

    if (plans.length === 0) {
      throw new Error('No se encontró el plan gratuito.');
    }

    await connection.execute(
      `INSERT INTO subscriptions (user_id, plan_id, status)
       VALUES (?, ?, 'active')`,
      [userResult.insertId, plans[0].id]
    );

    await connection.commit();

    const token = createToken(userResult.insertId);

    return res.status(201).json({
      success: true,
      message: 'Cuenta creada correctamente.',
      token,
      user: {
        id: userResult.insertId,
        name,
        email,
        plan: 'free'
      }
    });
  } catch (error) {
    await connection.rollback();

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ER_DUP_ENTRY'
    ) {
      return res.status(409).json({
        success: false,
        message: 'Este correo ya está registrado.'
      });
    }

    console.error('Error al registrar usuario:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo crear la cuenta.'
    });
  } finally {
    connection.release();
  }
}

export async function login(req: Request, res: Response) {
  const email = typeof req.body.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';

  const password = typeof req.body.password === 'string'
    ? req.body.password
    : '';

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Ingresa tu correo y contraseña.'
    });
  }

  try {
    const [users] = await pool.execute<UserRow[]>(
      `SELECT id, name, email, password_hash, status
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email]
    );

    const user = users[0];

    if (
      !user ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        success: false,
        message: 'Correo o contraseña incorrectos.'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'La cuenta está suspendida.'
      });
    }

    const token = createToken(user.id);

    return res.json({
      success: true,
      message: 'Inicio de sesión correcto.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Error al iniciar sesión:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo iniciar sesión.'
    });
  }
}



export async function updateProfile(req: Request, res: Response) {
  const userId = res.locals.userId as number;

  const name = typeof req.body.name === 'string'
    ? req.body.name.trim()
    : '';

  const email = typeof req.body.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';

  if (!name || name.length > 120) {
    return res.status(400).json({
      success: false,
      message: 'Ingresa un nombre válido de hasta 120 caracteres.'
    });
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 190
  ) {
    return res.status(400).json({
      success: false,
      message: 'Ingresa un correo electrónico válido.'
    });
  }

  try {
    const [users] = await pool.execute<UserRow[]>(
      `SELECT id
       FROM users
       WHERE email = ? AND id <> ?
       LIMIT 1`,
      [email, userId]
    );

    if (users.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Ese correo ya está registrado por otra cuenta.'
      });
    }

    const [result] = await pool.execute<ResultSetHeader>(
      `UPDATE users
       SET name = ?, email = ?
       WHERE id = ? AND status = 'active'`,
      [name, email, userId]
    );

    if (result.affectedRows === 0) {
      const [currentUsers] = await pool.execute<UserRow[]>(
        `SELECT id
         FROM users
         WHERE id = ? AND status = 'active'
         LIMIT 1`,
        [userId]
      );

      if (currentUsers.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'La cuenta no está disponible.'
        });
      }
    }

    return res.json({
      success: true,
      message: 'Perfil actualizado correctamente.',
      user: {
        id: userId,
        name,
        email
      }
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ER_DUP_ENTRY'
    ) {
      return res.status(409).json({
        success: false,
        message: 'Ese correo ya está registrado.'
      });
    }

    console.error('Error al actualizar perfil:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo actualizar el perfil.'
    });
  }
}
