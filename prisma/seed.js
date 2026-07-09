const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

const ACCOUNTS = [
  {
    bankCode: "BCI",
    bankName: "BCI",
    accountNumber: "2196",
    displayNumber: "2196",
    holderName: "ME SPA",
    holderRut: "77333096-4",
    currency: "CLP",
  },
  {
    bankCode: "SANTANDER",
    bankName: "Santander",
    accountNumber: "95800580",
    displayNumber: "0-000-9580058-0",
    holderName: "BACO SPA",
    holderRut: "78026624-4",
    currency: "CLP",
  },
  {
    bankCode: "SANTANDER",
    bankName: "Santander",
    accountNumber: "94050340",
    displayNumber: "0-000-9405034-0",
    holderName: "MG SPA",
    holderRut: "77333097-2",
    currency: "CLP",
  },
  {
    bankCode: "SANTANDER",
    bankName: "Santander",
    accountNumber: "94157609",
    displayNumber: "0-000-9415760-9",
    holderName: "ME SPA",
    holderRut: "77333096-4",
    currency: "CLP",
  },
  {
    bankCode: "INTERNACIONAL",
    bankName: "Banco Internacional",
    accountNumber: "9822911",
    displayNumber: "9822911",
    holderName: "MORECAPITAL",
    // RUT de More Capital SpA. Sin esto el matcher de traspasos internos no
    // puede mapear la cuenta como destino y TODOS los traspasos a More Capital
    // quedan huérfanos (no-dest-account). Antes se parchaba post-install con
    // scripts/fix-holder-rut.ts; ahora nace correcto desde el seed.
    holderRut: "76815928-9",
    currency: "CLP",
  },
  {
    // Banco de Chile NO participa en el motor de conciliación
    // (no está en REGISTERED_BANK_CODES de reconciliation/match.ts).
    // Se registra solo para que aparezca en el dashboard y se pueda importar
    // su cartola sin caer en "Sin asignar".
    bankCode: "CHILE",
    bankName: "Banco de Chile",
    accountNumber: "51541406",
    displayNumber: "000051541406",
    holderName: "ME SPA",
    holderRut: "77333096-4",
    currency: "CLP",
  },
  // Cuentas "Sin asignar" — buffer para movimientos cuyo archivo de cartola
  // no matchea con una cuenta real registrada. Se identifican por accountNumber
  // con prefijo "_UNASSIGNED_". El usuario reasigna manualmente desde el UI.
  {
    bankCode: "BCI",
    bankName: "BCI",
    accountNumber: "_UNASSIGNED_BCI",
    displayNumber: null,
    holderName: "Sin asignar",
    holderRut: null,
    currency: "CLP",
    alias: "Sin asignar - BCI",
  },
  {
    bankCode: "SANTANDER",
    bankName: "Santander",
    accountNumber: "_UNASSIGNED_SANTANDER",
    displayNumber: null,
    holderName: "Sin asignar",
    holderRut: null,
    currency: "CLP",
    alias: "Sin asignar - Santander",
  },
  {
    bankCode: "INTERNACIONAL",
    bankName: "Banco Internacional",
    accountNumber: "_UNASSIGNED_INTERNACIONAL",
    displayNumber: null,
    holderName: "Sin asignar",
    holderRut: null,
    currency: "CLP",
    alias: "Sin asignar - Banco Internacional",
  },
  {
    bankCode: "CHILE",
    bankName: "Banco de Chile",
    accountNumber: "_UNASSIGNED_CHILE",
    displayNumber: null,
    holderName: "Sin asignar",
    holderRut: null,
    currency: "CLP",
    alias: "Sin asignar - Banco de Chile",
  },
];

// Perfiles base (variables de permisos). Idempotente; la migración
// 20260625200000_add_perfiles ya los crea — esto los repara si faltan.
const PERMISOS_TODO = {
  modulos: { dashboard: true, consolidados: true, cartolas: true, movimientos: true, reportes: true },
  acciones: { conciliar: true, reevaluar: true, generarAsientos: true, importar: true, depurar: true, configurar: true, gestionarUsuarios: true },
};
const PERFILES = [
  { id: "perfil-admin", nombre: "Admin", esAdmin: true, permisos: PERMISOS_TODO },
  {
    id: "perfil-operador",
    nombre: "Operador conciliación",
    esAdmin: false,
    permisos: {
      modulos: { ...PERMISOS_TODO.modulos },
      acciones: { conciliar: true, reevaluar: true, generarAsientos: true, importar: true, depurar: true, configurar: false, gestionarUsuarios: false },
    },
  },
  {
    id: "perfil-lectura",
    nombre: "Solo lectura",
    esAdmin: false,
    permisos: {
      modulos: { ...PERMISOS_TODO.modulos },
      acciones: { conciliar: false, reevaluar: false, generarAsientos: false, importar: false, depurar: false, configurar: false, gestionarUsuarios: false },
    },
  },
];

async function seedPerfiles() {
  for (const p of PERFILES) {
    await prisma.perfil.upsert({
      where: { id: p.id },
      update: { nombre: p.nombre, esAdmin: p.esAdmin },
      create: p,
    });
    console.log(`✓ Perfil: ${p.nombre}`);
  }
}

async function seedUser() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME || "Gerencia";

  if (!email || !password) {
    throw new Error(
      "Define SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD en .env antes de correr el seed."
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { name, active: true, perfilId: "perfil-admin" },
    create: { email, passwordHash, name, active: true, perfilId: "perfil-admin" },
  });
  console.log(`✓ Usuario gerencia: ${user.email} (Admin)`);
}

async function seedAccounts() {
  for (const acc of ACCOUNTS) {
    const result = await prisma.bankAccount.upsert({
      where: {
        bankCode_accountNumber: {
          bankCode: acc.bankCode,
          accountNumber: acc.accountNumber,
        },
      },
      update: {
        bankName: acc.bankName,
        displayNumber: acc.displayNumber,
        holderName: acc.holderName,
        holderRut: acc.holderRut,
        currency: acc.currency,
        active: true,
      },
      create: { ...acc, active: true },
    });
    console.log(`✓ Cuenta: ${result.bankCode} ${result.accountNumber} (${result.holderName})`);
  }
}

async function main() {
  await seedPerfiles();
  await seedUser();
  await seedAccounts();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
