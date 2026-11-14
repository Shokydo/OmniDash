'use strict';
/**
 * Система ролей панели: вместо «админ / пользователь» — настраиваемые роли
 * с наборами разрешений. Встроенные роли нельзя удалить, но можно править.
 */
const { id } = require('./util');

const PERMISSIONS = [
  { id: 'servers.create', label: 'Создание серверов' },
  { id: 'servers.manage', label: 'Управление своими серверами' },
  { id: 'servers.delete', label: 'Удаление серверов' },
  { id: 'users.manage', label: 'Управление пользователями' },
  { id: 'nodes.manage', label: 'Управление узлами и портами' },
  { id: 'eggs.manage', label: 'Управление шаблонами' },
  { id: 'roles.manage', label: 'Управление ролями' },
  { id: 'audit.view', label: 'Просмотр журнала' },
  { id: 'updates.manage', label: 'Обновления панели' },
  { id: 'settings.manage', label: 'Настройки панели' },
  { id: 'backups.manage', label: 'Бэкапы всех серверов' },
];

const ALL = PERMISSIONS.map((p) => p.id);

function builtinRoles() {
  return [
    {
      id: 'role_admin',
      name: 'Администратор',
      builtin: true,
      permissions: ALL.slice(),
      createdAt: Date.now(),
    },
    {
      id: 'role_moderator',
      name: 'Модератор',
      builtin: true,
      permissions: ['servers.create', 'servers.manage', 'audit.view'],
      createdAt: Date.now(),
    },
    {
      id: 'role_user',
      name: 'Пользователь',
      builtin: true,
      permissions: ['servers.manage'],
      createdAt: Date.now(),
    },
  ];
}

function ensureRoles(data) {
  if (!Array.isArray(data.roles) || !data.roles.length) {
    data.roles = builtinRoles();
    return true;
  }
  return false;
}

function roleById(data, roleId) {
  return (data.roles || []).find((r) => r.id === roleId) || null;
}

function permissionsOf(data, user) {
  if (!user) return [];
  if (user.role === 'admin') return ALL.slice();
  const role = roleById(data, user.roleId);
  if (role) return (role.permissions || []).filter((p) => ALL.includes(p));
  if (user.role === 'user') return ['servers.manage'];
  return [];
}

function hasPerm(data, user, perm) {
  return permissionsOf(data, user).includes(perm);
}

function publicRole(role) {
  return {
    id: role.id,
    name: role.name,
    builtin: !!role.builtin,
    permissions: role.permissions || [],
    createdAt: role.createdAt || null,
  };
}

function createRole(data, { name, permissions }) {
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName) throw new Error('Укажите название роли');
  if ((data.roles || []).some((r) => r.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('Роль с таким названием уже существует');
  }
  const role = {
    id: id('role'),
    name: cleanName,
    builtin: false,
    permissions: (permissions || []).filter((p) => ALL.includes(p)),
    createdAt: Date.now(),
  };
  data.roles.push(role);
  return role;
}

function updateRole(data, roleId, { name, permissions }) {
  const role = roleById(data, roleId);
  if (!role) throw new Error('Роль не найдена');
  if (name !== undefined) {
    const cleanName = String(name).trim().slice(0, 60);
    if (!cleanName) throw new Error('Укажите название роли');
    if ((data.roles || []).some((r) => r.id !== roleId && r.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error('Роль с таким названием уже существует');
    }
    role.name = cleanName;
  }
  if (permissions !== undefined) {
    role.permissions = (permissions || []).filter((p) => ALL.includes(p));
  }
  return role;
}

function deleteRole(data, roleId) {
  const role = roleById(data, roleId);
  if (!role) throw new Error('Роль не найдена');
  if (role.builtin) throw new Error('Встроенную роль удалить нельзя');
  const used = (data.users || []).filter((u) => u.roleId === roleId).length;
  if (used) throw new Error(`Роль назначена ${used} пользователям — сначала переназначьте их`);
  data.roles = data.roles.filter((r) => r.id !== roleId);
  return role;
}

module.exports = {
  PERMISSIONS, ALL, builtinRoles, ensureRoles, roleById,
  permissionsOf, hasPerm, publicRole, createRole, updateRole, deleteRole,
};
