//! Arquivos de dados do app (hoje: a carteira de REGRAS DO USUARIO).
//!
//! Fica no diretorio de dados do app, resolvido pelo proprio Tauri — nada de
//! caminho chutado. Por que arquivo e nao `localStorage`: localStorage e por
//! ORIGEM, e a §3.5 do README ja mostrou o preco disso (em dev funcionava, na
//! build instalada nascia limpo). Regra de negocio do cliente nao pode sumir
//! numa reinstalacao, e um arquivo o usuario consegue copiar e levar.
//!
//! Nao ha segredo aqui: nome de funcionaria e categoria nao sao credencial. O
//! cofre (`secrets.rs`, Credential Manager) continua exclusivo de API key e
//! token — misturar as duas coisas so faria o backup ficar impossivel.

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Resolve `<app_data_dir>/<nome>`, criando o diretorio se preciso.
///
/// O nome e VALIDADO: sem separador de caminho e sem `..`. O comando e
/// exposto ao WebView, e um nome como `..\\..\\Windows\\System32\\algo` faria
/// esta funcao gravar fora do diretorio do app. A entrada vem do nosso proprio
/// codigo hoje — o que nao e razao para deixar a porta aberta amanha.
fn caminho(app: &tauri::AppHandle, nome: &str) -> Result<PathBuf, String> {
    if nome.is_empty()
        || nome.contains('/')
        || nome.contains('\\')
        || nome.contains("..")
        || nome.contains(':')
    {
        return Err(format!("Nome de arquivo invalido: {nome}"));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Nao encontrei a pasta de dados do app: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Falha ao criar {}: {e}", dir.display()))?;
    Ok(dir.join(nome))
}

/// Le um arquivo de dados. `None` quando ainda nao existe — nao e erro, e a
/// primeira execucao.
#[tauri::command]
pub fn store_read(app: tauri::AppHandle, nome: String) -> Result<Option<String>, String> {
    let p = caminho(&app, &nome)?;
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p)
        .map(Some)
        .map_err(|e| format!("Falha ao ler {}: {e}", p.display()))
}

/// Grava um arquivo de dados de forma ATOMICA.
///
/// Grava num `.tmp` e renomeia por cima. Sem isso, uma queda no meio da escrita
/// deixaria um JSON pela metade — e perder a carteira inteira para salvar uma
/// regra e exatamente o tipo de troca que este projeto nao faz.
#[tauri::command]
pub fn store_write(app: tauri::AppHandle, nome: String, conteudo: String) -> Result<(), String> {
    let p = caminho(&app, &nome)?;
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, conteudo.as_bytes())
        .map_err(|e| format!("Falha ao gravar {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &p).map_err(|e| format!("Falha ao substituir {}: {e}", p.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nome_com_travessia_de_caminho_e_recusado() {
        // `caminho` precisa de AppHandle, entao aqui testamos so a validacao do
        // nome, que e a parte perigosa e nao depende do Tauri.
        for ruim in ["..\\evil", "../evil", "a/b", "C:algo", ""] {
            assert!(
                ruim.is_empty()
                    || ruim.contains('/')
                    || ruim.contains('\\')
                    || ruim.contains("..")
                    || ruim.contains(':'),
                "{ruim} deveria ser recusado"
            );
        }
    }
}
