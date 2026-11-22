import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import fs from "fs";
import { createApiRouter, loadDatasets } from "./server/api";

dotenv.config();

const CONFIG_PATH = path.join(process.cwd(), "config-settings.json");

// Helper to load and merge dynamic configurations
function getDynamicConfig() {
  const config = {
    WEB3FORMS_ACCESS_KEY: process.env.WEB3FORMS_ACCESS_KEY || "",
    SMTP_HOST: process.env.SMTP_HOST || "",
    SMTP_PORT: process.env.SMTP_PORT || "587",
    SMTP_USER: process.env.SMTP_USER || "",
    SMTP_PASS: process.env.SMTP_PASS || "",
    SMTP_FROM: process.env.SMTP_FROM || "",
    SMTP_SECURE: process.env.SMTP_SECURE || "false",
  };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const savedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      Object.assign(config, savedConfig);
      
      // Sync to process.env so existing codebase routes work automatically
      for (const [key, value] of Object.entries(config)) {
        process.env[key] = (value as string) || "";
      }
    }
  } catch (err) {
    console.warn("[Config] Error loading config-settings.json:", err);
  }
  return config;
}

// Helper to update the actual .env file on disk to persist configs through restarts
function updateEnvFile(config: Record<string, string>) {
  try {
    const envPath = path.join(process.cwd(), ".env");
    let envContent = "";
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");
    }

    const lines = envContent.split(/\r?\n/);
    
    for (const [key, value] of Object.entries(config)) {
      const regex = new RegExp(`^${key}=.*`);
      const lineIndex = lines.findIndex(line => regex.test(line.trim()));
      const escapedValue = value.replace(/"/g, '\\"');
      const newLine = `${key}="${escapedValue}"`;
      if (lineIndex !== -1) {
        lines[lineIndex] = newLine;
      } else {
        lines.push(newLine);
      }
    }

    fs.writeFileSync(envPath, lines.join("\n"), "utf8");
    console.log("[Config] Successfully synchronized and wrote dynamic configurations directly to .env file too.");
  } catch (err) {
    console.warn("[Config] Failed to write fallback configuration to .env file:", err);
  }
}

// Initial Sync
getDynamicConfig();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Use JSON body parser for incoming API payloads
  app.use(express.json());

  // Public read API (elections, census) - JSON only
  app.use("/api/v1", createApiRouter(loadDatasets()));

  // API Route: Get dynamic OTP configurations (Super Admin only)
  app.get("/api/admin/config", (req, res) => {
    const userRole = req.headers["x-user-role"] || req.query.role;
    if (userRole !== "Super Admin") {
      return res.status(403).json({ success: false, error: "Unauthorized access: State Administrator clearance required." });
    }

    const currentConfig = getDynamicConfig();
    return res.json({ success: true, config: currentConfig });
  });

  // API Route: Update and persist dynamic OTP configurations (Super Admin only)
  app.post("/api/admin/config", (req, res) => {
    const userRole = req.headers["x-user-role"] || req.query.role;
    if (userRole !== "Super Admin") {
      return res.status(403).json({ success: false, error: "Unauthorized access: State Administrator clearance required." });
    }

    const newConfig = req.body;
    const allowedKeys = [
      "WEB3FORMS_ACCESS_KEY",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASS",
      "SMTP_FROM",
      "SMTP_SECURE",
    ];

    const filteredConfig: Record<string, string> = {};
    for (const key of allowedKeys) {
      if (typeof newConfig[key] === "string") {
        filteredConfig[key] = newConfig[key].trim();
      }
    }

    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(filteredConfig, null, 2), "utf8");
      
      // Update process.env in-memory immediately for real-time activation
      for (const [key, value] of Object.entries(filteredConfig)) {
        process.env[key] = value;
      }

      // Synchronize and persist keys to local .env configuration file on disk
      updateEnvFile(filteredConfig);
      
      console.log("[Config] Successfully saved new admin configurations to config-settings.json");
      return res.json({ success: true, message: "Configurations persisted and activated successfully worldwide!" });
    } catch (saveErr: any) {
      console.error("[Config] Save error:", saveErr);
      return res.status(500).json({ success: false, error: "Failed to write config settings file." });
    }
  });

  // API Route: Send secure login OTP email to Observers/Admins
  app.post("/api/send-otp", async (req, res) => {
    // Dynamically refresh config configurations on-demand
    getDynamicConfig();

    const { email, phone, otp, method } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, error: "Missing required fields: email and otp" });
    }

    console.log(`[API /api/send-otp] Request: email=${email}, phone=${phone}, otp=${otp}, method=${method}`);

    // Accumulate errors for diagnostic reporting
    const attempts: string[] = [];

    // Option 1: Live SMTP dispatch via Nodemailer (Most resilient worldwide)
    if (process.env.SMTP_HOST) {
      try {
        console.log(`[API /api/send-otp] Attempting global delivery via SMTP: ${process.env.SMTP_HOST}...`);
        
        const smtpUser = (process.env.SMTP_USER || "").trim();
        const smtpPass = (process.env.SMTP_PASS || "").trim();
        
        if (!smtpUser || !smtpPass) {
          throw new Error("SMTP authentication credentials (Username or Password/App Token) are empty. Please configure them in the Secure Admin settings tab.");
        }

        const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
        // Nodemailer: secure must be false for port 587 (which uses STARTTLS upgrade),
        // and true for port 465 (SSL/TLS direct channel).
        const isSecure = smtpPort === 465 || (process.env.SMTP_SECURE === "true" && smtpPort !== 587);

        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: smtpPort,
          secure: isSecure,
          auth: {
            user: smtpUser,
            pass: smtpPass,
          },
          tls: {
            rejectUnauthorized: false, // Prevents sandboxed SSL handshaking errors
          },
        });

        const fromHeader = process.env.SMTP_FROM || `"People Pulse AP Observer Security" <${smtpUser}>`;
        const mailOptions = {
          from: fromHeader,
          to: email,
          subject: "People Pulse Secure Verification OTP Code",
          html: `
            <div style="font-family: Arial, sans-serif; padding: 25px; border: 1px solid #e2e8f0; max-width: 500px; margin: 0 auto; border-radius: 8px; background-color: #ffffff;">
              <h2 style="color: #A01D24; font-weight: bold; font-style: italic; border-bottom: 2px solid #e2e8f0; padding-bottom: 15px; margin-top: 0;">People Pulse Andhra Pradesh</h2>
              <p style="font-size: 14px; color: #334155; line-height: 1.5;">Hello,</p>
              <p style="font-size: 14px; color: #334155; line-height: 1.5;">You are receiving this secure verification code to validate your identity on the <strong>People Pulse Andhra Pradesh Platform</strong> as a State Observer / Administrator.</p>
              
              <div style="background: #faf8f5; padding: 20px; border: 1.5px dashed #A01D24; border-left: 6px solid #A01D24; margin: 24px 0; text-align: center; border-radius: 4px;">
                <span style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: #64748b; font-weight: bold; display: block; margin-bottom: 6px;">SECURE OBSERVER OTP CODE</span>
                <strong style="font-size: 32px; font-family: 'Courier New', monospace; color: #1e293b; letter-spacing: 6px; font-weight: 800;">${otp}</strong>
              </div>
              
              <p style="font-size: 12px; color: #64748b; line-height: 1.5;">This verification token is valid for 10 minutes. If you did not trigger this dispatch request, please disregard this notification and secure your credentials.</p>
              <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 22px 0;" />
              <footer style="font-size: 10px; color: #94a3b8; text-align: center;">
                People Pulse AP Observer Security Gateway • Confidential Platform Clearance
              </footer>
            </div>
          `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[API /api/send-otp] SMTP delivery succeeded! MessageId: ${info.messageId}`);
        return res.json({
          success: true,
          simulated: false,
          service: "smtp",
          message: `Secure validation email successfully dispatched to ${email} via SMTP.`,
        });
      } catch (smtpErr: any) {
        const errorMsg = smtpErr.message || String(smtpErr);
        console.error(`[API /api/send-otp] SMTP delivery failed:`, errorMsg);
        
        let customError = `SMTP error: ${errorMsg}`;
        if (errorMsg.includes("534-5.7.9") || errorMsg.toLowerCase().includes("application-specific password") || errorMsg.includes("InvalidSecondFactor")) {
          customError += " -> [CRITICAL ACTION REQUIRED: Google requires a 16-character 'App Password' for Gmail SMTP if 2-Step Verification is active. Standard passwords are blocked. Go to Google Account Settings -> Security -> 2-Step Verification -> App Passwords, generate a 16-character code, and put it in SMTP Password in Admin Settings]";
        }
        attempts.push(customError);
      }
    }

    // Option 2: Delivery via Web3Forms API
    if (process.env.WEB3FORMS_ACCESS_KEY) {
      try {
        console.log(`[API /api/send-otp] Attempting delivery via Web3Forms API...`);
        const response = await fetch("https://api.web3forms.com/submit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            access_key: process.env.WEB3FORMS_ACCESS_KEY,
            name: "People Pulse Andhra Pradesh",
            email: email,
            subject: "People Pulse AP Observer OTP Security PIN",
            message: `Hello,\n\nYour secure observer login OTP verification code is: ${otp}.\n\nThis verification code was sent to authenticate your observer profile session. Enter this code to accredit workspace access.\n\nThank you,\nPeople Pulse AP Verification Systems`,
          }),
        });

        const data = await response.json();
        if (response.ok && data.success) {
          console.log(`[API /api/send-otp] Web3Forms delivery succeeded.`);
          return res.json({
            success: true,
            simulated: false,
            service: "web3forms",
            message: `Secure validation email successfully dispatched to ${email} via Web3Forms.`,
          });
        } else {
          console.error(`[API /api/send-otp] Web3Forms delivery failed:`, data);
          attempts.push(`Web3Forms error: ${data.message || "rejection"}`);
        }
      } catch (e: any) {
        console.error(`[API /api/send-otp] Web3Forms dispatch caught error:`, e.message || e);
        attempts.push(`Web3Forms error: ${e.message || e}`);
      }
    }

    // If explicit production credentials were set, do NOT fallback to a silent local simulation.
    // Instead, return an extremely clear, actionable error containing all diagnostics!
    if (process.env.SMTP_HOST || process.env.WEB3FORMS_ACCESS_KEY) {
      return res.status(400).json({
        success: false,
        error: `Active production credentials failed transmission: [${attempts.join(" | ")}]. Please check your host URL, SSL port, authentication password, or whitelist in the Secure Admin settings tab.`,
      });
    }

    // Default Sandbox Simulation when absolutely no credentials are set
    console.log(`
============================================================
[SIMULATION SECURITY LOG] OTP GENERATION DISPATCH
------------------------------------------------------------
Recipient Email: ${email}
Recipient Phone: ${phone || "N/A"}
Delivery Route:  ${method || "email"}
Dispatched Code: ${otp}
Timestamp:       ${new Date().toISOString()}
------------------------------------------------------------
* Note: To receive a real dispatch directly to your inbox,
  please configure SMTP parameters or WEB3FORMS_ACCESS_KEY
  in the dynamic Admin settings tab.
============================================================
    `);

    return res.json({
      success: true,
      simulated: true,
      service: "simulation",
      message: `No live parameters configured. Local simulation triggered! OTP code is ${otp}.`,
    });
  });

  // Vite Server Middleware Routing
  if (process.env.NODE_ENV !== "production") {
    console.log("[Dev Server] Mounting Vite development middleware layers...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("[Prod Server] Serving production static asset bundles...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server fully operational on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Critical server bootstrap error:", error);
  process.exit(1);
});
