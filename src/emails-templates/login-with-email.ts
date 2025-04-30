export const loginWithEmailTemplate = (url: string, email: string) => `
<table
  align="center"
  width="100%"
  border="0"
  cellpadding="0"
  cellspacing="0"
  role="presentation"
  style="
    max-width: 500px;
    margin-left: auto;
    margin-right: auto;
    margin-top: 2.5rem;
    margin-bottom: 2.5rem;
    border-radius: 0.375rem;
    border-width: 1px;
    border-style: solid;
    border-color: rgb(229, 231, 235);
    padding-left: 2.5rem;
    padding-right: 2.5rem;
    padding-top: 1.25rem;
    padding-bottom: 1.25rem;
  "
>
  <tbody>
    <tr style="width: 100%">
      <td>
        <table
          align="center"
          width="100%"
          border="0"
          cellpadding="0"
          cellspacing="0"
          role="presentation"
          style="margin-top: 2rem"
        ></table>
        <h1
          style="
            margin-left: 0px;
            margin-right: 0px;
            margin-top: 1.75rem;
            margin-bottom: 1.75rem;
            padding: 0px;
            text-align: center;
            font-size: 1.25rem;
            line-height: 1.75rem;
            font-weight: 600;
            color: rgb(0, 0, 0);
          "
        >
          Seu Link de Acesso
        </h1>
        <p
          style="
            font-size: 0.875rem;
            line-height: 1.5rem;
            margin: 16px 0;
            color: rgb(0, 0, 0);
          "
        >
          Bem vindo a RocketSend!
        </p>
        <p
          style="
            font-size: 0.875rem;
            line-height: 1.5rem;
            margin: 16px 0;
            color: rgb(0, 0, 0);
          "
        >
          Favor, clique no link mágico abaixo para fazer login em sua conta.
        </p>
        <table
          align="center"
          width="100%"
          border="0"
          cellpadding="0"
          cellspacing="0"
          role="presentation"
          style="margin-top: 2rem; margin-bottom: 2rem; text-align: center"
        >
          <tbody>
            <tr>
              <td>
                <a
                  href="${url}"
                  style="
                    color: rgb(255, 255, 255);
                    text-decoration: none;
                    border-radius: 9999px;
                    background-color: rgb(0, 0, 0);
                    padding-left: 1.5rem;
                    padding-right: 1.5rem;
                    padding-top: 0.75rem;
                    padding-bottom: 0.75rem;
                    text-align: center;
                    font-size: 12px;
                    font-weight: 600;
                    text-decoration-line: none;
                  "
                  target="_blank"
                  >Acessar RocketSend</a
                >
              </td>
            </tr>
          </tbody>
        </table>
        <p
          style="
            font-size: 0.875rem;
            line-height: 1.5rem;
            margin: 16px 0;
            color: rgb(0, 0, 0);
          "
        >
          ou copie e cole este URL em seu navegador:
        </p>
        <p
          style="
            font-size: 14px;
            line-height: 24px;
            margin: 16px 0;
            max-width: 24rem;
            font-weight: 500;
            color: rgb(147, 51, 234);
            text-decoration-line: none;
          "
        >
          <a href="${url}" target="_blank">${url}</a>
        </p>
        <hr
          style="
            width: 100%;
            border: none;
            border-top: 1px solid #eaeaea;
            margin-left: 0px;
            margin-right: 0px;
            border-width: 1px;
            border-color: rgb(229, 231, 235);
            margin-top: 1.5rem;
            margin-bottom: 1.5rem;
          "
        />
        <p
          style="
            font-size: 12px;
            line-height: 1.5rem;
            margin: 16px 0;
            color: rgb(107, 114, 128);
          "
        >
          Este e-mail foi destinado a
          <span style="color: rgb(0, 0, 0)">
            <a href="mailto:${email}" target="_blank">${email}</a>
          </span>. Se você não esperava este e-mail, pode ignorá-lo. Se você está
          preocupado abouta segurança da sua conta, responda a este e-mail para
          entrar em contato conosco.
        </p>
      </td>
    </tr>
  </tbody>
</table>
      `;
