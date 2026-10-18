import { createPool, migrate, transaction } from "./db.mjs";
import { email, text, id, passwordHash, check } from "./security.mjs";
const pool = createPool(process.env.DATABASE_URL);
try {
  const [, , command, address, name] = process.argv;
  if (command === "migrate") {
    await migrate(pool);
    console.log("Platform schema ready");
  } else if (command === "grant-admin") {
    await transaction(pool, async (db) => {
      const { rows } = await db.query(
        "SELECT id,is_admin FROM platform_users WHERE email=$1 AND NOT disabled FOR UPDATE",
        [email(address)],
      );
      check(rows[0], 404, "Enabled account not found");
      if (rows[0].is_admin) return;
      await db.query("UPDATE platform_users SET is_admin=true WHERE id=$1", [
        rows[0].id,
      ]);
      await db.query(
        "INSERT INTO audit_events(actor_id,action,resource) VALUES($1,'account.admin.grant',$2)",
        [rows[0].id, "offline-cli"],
      );
    });
    console.log("System administrator granted; password unchanged");
  } else if (
    ["create-user", "create-admin", "reset-password"].includes(command)
  ) {
    check(
      !process.stdin.isTTY,
      400,
      "Pipe password from a protected file/stdin; do not put passwords in command arguments",
    );
    let password = "";
    for await (const chunk of process.stdin) {
      password += chunk;
      check(password.length <= 1024);
    }
    const encoded = await passwordHash(password.replace(/\r?\n$/, ""));
    await transaction(pool, async (db) => {
      if (command === "create-user" || command === "create-admin")
        await db.query(
          "INSERT INTO platform_users(id,email,name,password_hash,is_admin) VALUES($1,$2,$3,$4,$5)",
          [
            id(),
            email(address),
            text(name),
            encoded,
            command === "create-admin",
          ],
        );
      else {
        const { rows } = await db.query(
          "UPDATE platform_users SET password_hash=$2,password_version=password_version+1 WHERE email=$1 RETURNING id",
          [email(address), encoded],
        );
        check(rows[0], 404, "Account not found");
        await db.query("DELETE FROM password_reset_tokens WHERE user_id=$1", [
          rows[0].id,
        ]);
        await db.query("DELETE FROM platform_sessions WHERE user_id=$1", [
          rows[0].id,
        ]);
      }
    });
    console.log("Account updated; password not logged");
  } else
    throw new Error(
      "Usage: admin.mjs migrate | grant-admin EMAIL | create-user EMAIL NAME | create-admin EMAIL NAME | reset-password EMAIL (password via stdin)",
    );
} catch (error) {
  console.error(error.code || error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
