import { createPool, migrate, transaction } from "./db.mjs";
import { email, text, id, passwordHash, check } from "./security.mjs";
const pool = createPool(process.env.DATABASE_URL);
try {
  const [, , command, address, name] = process.argv;
  if (command === "migrate") {
    await migrate(pool);
    console.log("Platform schema ready");
  } else if (command === "create-user" || command === "reset-password") {
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
      if (command === "create-user")
        await db.query(
          "INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
          [id(), email(address), text(name), encoded],
        );
      else {
        const { rows } = await db.query(
          "UPDATE platform_users SET password_hash=$2 WHERE email=$1 RETURNING id",
          [email(address), encoded],
        );
        check(rows[0], 404, "Account not found");
        await db.query("DELETE FROM platform_sessions WHERE user_id=$1", [
          rows[0].id,
        ]);
      }
    });
    console.log("Account updated; password not logged");
  } else
    throw new Error(
      "Usage: admin.mjs migrate | create-user EMAIL NAME | reset-password EMAIL (password via stdin)",
    );
} catch (error) {
  console.error(error.code || error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
