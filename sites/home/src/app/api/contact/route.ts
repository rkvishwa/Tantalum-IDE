import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, email, subject, message } = body;

    // Basic validation
    if (!name || !email || !subject || !message) {
      return NextResponse.json(
        { error: "All fields are required." },
        { status: 400 }
      );
    }

    // Create transporter using your SMTP credentials
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true", // true for port 465, false for 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: `"Knurdz Contact" <${process.env.SMTP_USER}>`,
      to: process.env.EMAIL_TO,
      replyTo: email,
      subject: `[Knurdz] ${subject} — from ${name}`,
      html: `
        <div style="font-family:monospace;background:#000;color:#fff;padding:32px;border-radius:8px;max-width:600px;">
          <h2 style="color:#22c55e;margin:0 0 24px;">New Contact Form Submission</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:8px 0;color:#9ca3af;width:80px;vertical-align:top;">Name</td>
              <td style="padding:8px 0;">${name}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#9ca3af;vertical-align:top;">Email</td>
              <td style="padding:8px 0;"><a href="mailto:${email}" style="color:#22c55e;">${email}</a></td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#9ca3af;vertical-align:top;">Topic</td>
              <td style="padding:8px 0;">${subject}</td>
            </tr>
          </table>
          <hr style="border:none;border-top:1px solid #333;margin:24px 0;" />
          <p style="color:#9ca3af;margin:0 0 8px;font-size:12px;">MESSAGE</p>
          <p style="color:#e5e7eb;line-height:1.8;white-space:pre-wrap;margin:0;">${message}</p>
        </div>
      `,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Contact API error:", err);
    return NextResponse.json(
      { error: "Failed to send message. Please try again." },
      { status: 500 }
    );
  }
}
