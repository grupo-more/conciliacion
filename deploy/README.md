# Deploy en servidor Windows

Instalación y mantenimiento del sistema de Conciliación.

## Prerrequisitos

Instalar una sola vez en el servidor:

| Software | Link | Por qué |
|---|---|---|
| **Node.js 20 LTS** | https://nodejs.org | Runtime |
| **PostgreSQL 18** | https://www.postgresql.org/download/windows/ | Base de datos |
| **Git** (opcional) | https://git-scm.com | Para `update.bat` |

Anota la **password del usuario `postgres`** que pongas durante la instalación de PostgreSQL — la vas a necesitar.

## Primera instalación

1. Bajar el código al servidor:
   ```powershell
   cd C:\
   git clone <url-del-repo> conciliacion
   cd conciliacion
   ```
   (O copiar la carpeta por red, sin `node_modules` ni `.next`.)

2. Abrir **PowerShell como administrador** y correr:
   ```powershell
   cd C:\conciliacion
   .\deploy\setup.ps1
   ```

3. El script te va a preguntar:
   - Password del usuario `postgres`
   - Email del usuario gerencia (default: `gerencia@moregiros.cl`)
   - Password del usuario gerencia
   - Dynatech API URL/Key (default: los de la oficina)
   - Puerto (default: 3000)

4. Cuando termine, muestra la URL para acceder. Listo.

## Si PowerShell bloquea el script

Una sola vez:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## Acceder desde otras PC

Anota la IP del servidor:
```powershell
ipconfig
```

Desde cualquier PC en la misma red (o por VPN), abrir:
```
http://<IP-DEL-SERVIDOR>:3000
```

### Bonus: nombre amigable

En cada PC cliente, editar `C:\Windows\System32\drivers\etc\hosts` (como admin) y agregar:
```
192.168.X.X    conciliacion.local
```

Y acceder con `http://conciliacion.local:3000`.

## Operación diaria

```powershell
pm2 status              # estado del proceso
pm2 logs conciliacion   # ver logs en vivo (Ctrl+C para salir)
pm2 restart conciliacion
pm2 stop conciliacion
pm2 start conciliacion
```

## Actualizar a una nueva versión

```powershell
cd C:\conciliacion
.\deploy\update.bat
```

Hace `git pull`, instala deps si cambiaron, aplica schema, build y reinicia el servicio.

## Backup de la base de datos

Tarea programada recomendada (diaria):

```powershell
$fecha = Get-Date -Format "yyyy-MM-dd"
$env:PGPASSWORD = "TU_PASSWORD_POSTGRES"
& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -h localhost -d conciliacion -f "C:\backups\conciliacion_$fecha.sql"
```

Programarlo con `taskschd.msc` (Programador de tareas).

## Resolución de problemas

### El script falla con "no se puede ejecutar"
Ejecutar PowerShell como administrador, o:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### "Authentication failed" al crear la BD
La password del usuario `postgres` que ingresaste no es correcta. Re-corre el setup.

### "Port 3000 ya en uso"
Otro proceso lo está ocupando. Encuentra cuál con:
```powershell
netstat -ano | findstr :3000
```
O elige otro puerto y re-corre el setup.

### El sitio no responde desde otra PC pero sí desde el servidor
Es el firewall. Verificar la regla:
```powershell
Get-NetFirewallRule -DisplayName "Conciliación*"
```

### Los cambios de código no se reflejan
Cada vez que cambies código tienes que correr `update.bat` (o manualmente `npm run build` + `pm2 restart conciliacion`). En producción NO usamos `npm run dev`.

## Archivos importantes

| Archivo | Qué tiene |
|---|---|
| `.env` | Configuración de producción (no subir a git) |
| `~\.pm2\logs\conciliacion-out.log` | Logs de la app |
| `~\.pm2\logs\conciliacion-error.log` | Errores |
| `prisma\schema.prisma` | Modelo de datos |
