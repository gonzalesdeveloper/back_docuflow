
import { Router } from 'express';
import { login, register, updateProfile } from '../controllers/auth.controller';
import { authenticateToken } from '../middlewares/auth.middleware';
import pool from '../config/database';
import type { RowDataPacket } from 'mysql2';

interface ProfileRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
}

interface DocumentProfileRow extends RowDataPacket {
  id: number;
  user_id: number;
  dni: string | null;
  company_name: string | null;
  ruc: string | null;
  address: string | null;
  created_at: Date;
  updated_at: Date;
}

const router = Router();

router.post('/register', register);
router.post('/login', login);

// Consultar perfil personal
router.get('/me', authenticateToken, async (_req, res) => {
  try {
    const userId = res.locals.userId as number;

    const [users] = await pool.execute<ProfileRow[]>(
      `SELECT id, name, email
       FROM users
       WHERE id = ? AND status = 'active'
       LIMIT 1`,
      [userId]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'La cuenta no está disponible.'
      });
    }

    return res.json({
      success: true,
      user: users[0]
    });
  } catch (error) {
    console.error('Error al consultar perfil:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo consultar el perfil.'
    });
  }
});

// Actualizar perfil personal
router.put('/me', authenticateToken, updateProfile);

// Consultar datos reutilizables para documentos
router.get('/document-profile', authenticateToken, async (_req, res) => {
  try {
    const userId = res.locals.userId as number;

    const [rows] = await pool.execute<DocumentProfileRow[]>(
      `SELECT id, user_id, dni, company_name, ruc, address,
              created_at, updated_at
       FROM user_document_profiles
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );

    return res.json({
      success: true,
      profile: rows[0] ?? null
    });
  } catch (error) {
    console.error('Error al consultar datos documentales:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudieron consultar los datos documentales.'
    });
  }
});

// Crear o actualizar datos reutilizables
router.put('/document-profile', authenticateToken, async (req, res) => {
  try {
    const userId = res.locals.userId as number;

    const { dni, company_name, ruc, address } = req.body;

    const fields = {
      dni: { value: dni, max: 20 },
      company_name: { value: company_name, max: 180 },
      ruc: { value: ruc, max: 11 },
      address: { value: address, max: 255 }
    };

    const normalized: Record<string, string | null> = {};

    for (const [key, field] of Object.entries(fields)) {
      if (field.value !== undefined &&
          field.value !== null &&
          typeof field.value !== 'string') {
        return res.status(400).json({
          success: false,
          message: `El campo ${key} debe ser un texto válido.`
        });
      }

      const value = typeof field.value === 'string'
        ? field.value.trim()
        : '';

      if (value.length > field.max) {
        return res.status(400).json({
          success: false,
          message: `El campo ${key} supera el máximo de ${field.max} caracteres.`
        });
      }

      normalized[key] = value || null;
    }

    if (
      normalized.ruc !== null &&
      !/^\d{11}$/.test(normalized.ruc)
    ) {
      return res.status(400).json({
        success: false,
        message: 'El RUC debe contener exactamente 11 dígitos.'
      });
    }

    const [users] = await pool.execute<ProfileRow[]>(
      `SELECT id, name, email
       FROM users
       WHERE id = ? AND status = 'active'
       LIMIT 1`,
      [userId]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'La cuenta no está disponible.'
      });
    }

    await pool.execute(
      `INSERT INTO user_document_profiles
        (user_id, dni, company_name, ruc, address)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        dni = VALUES(dni),
        company_name = VALUES(company_name),
        ruc = VALUES(ruc),
        address = VALUES(address)`,
      [
        userId,
        normalized.dni,
        normalized.company_name,
        normalized.ruc,
        normalized.address
      ]
    );

    const [rows] = await pool.execute<DocumentProfileRow[]>(
      `SELECT id, user_id, dni, company_name, ruc, address,
              created_at, updated_at
       FROM user_document_profiles
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );

    return res.json({
      success: true,
      message: 'Datos documentales guardados correctamente.',
      profile: rows[0]
    });
  } catch (error) {
    console.error('Error al guardar datos documentales:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudieron guardar los datos documentales.'
    });
  }
});

export default router;
