export const emailCredentials = (
  name: string,
  clientId: string,
  clientSecret: string
) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Credenciais de Acesso</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background-color: #f4f4f4;
      margin: 0;
      padding: 0;
    }
    .email-container {
      max-width: 600px;
      margin: 20px auto;
      background: #ffffff;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }
    .header {
      background-color: #007bff;
      color: #ffffff;
      text-align: center;
      padding: 20px;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
    }
    .content {
      padding: 20px;
      color: #333333;
    }
    .content p {
      margin: 0 0 15px;
      line-height: 1.6;
    }
    .credentials {
      background-color: #f9f9f9;
      border: 1px solid #dddddd;
      padding: 15px;
      border-radius: 5px;
      margin: 20px 0;
    }
    .credentials p {
      margin: 5px 0;
      font-family: monospace;
      font-size: 14px;
    }
    .footer {
      text-align: center;
      padding: 15px;
      font-size: 12px;
      color: #777777;
      background-color: #f4f4f4;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <h1>Bem-vindo, ${name}!</h1>
    </div>
    <div class="content">
      <p>Estamos felizes em tê-lo como cliente. Aqui estão suas credenciais para uso da nossa api:</p>
      <div class="credentials">
        <p><strong>Client ID:</strong> ${clientId}</p>
        <p><strong>Client Secret:</strong> ${clientSecret}</p>
      </div>
      <p>Por favor, mantenha essas informações seguras e não as compartilhe com ninguém.</p>
      <p>Se precisar de ajuda, entre em contato com nosso suporte.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} BlibSend. Todos os direitos reservados.</p>
    </div>
  </div>
</body>
</html>
`;
