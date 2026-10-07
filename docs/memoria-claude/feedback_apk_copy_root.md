---
name: feedback-apk-copy-root
description: "Após gerar o APK, sempre copiar uma cópia para a pasta raiz do projeto"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c554c4e4-099f-4db4-9be7-16f7fef70214
---

Após qualquer build que gere o APK (`gradlew assembleDebug`), copiar o arquivo para a raiz do projeto:

```bash
cp "android/app/build/outputs/apk/debug/app-debug.apk" "app-debug.apk"
```

**Why:** O usuário quer o APK acessível diretamente na raiz (`C:\Users\desen\Documents\Apps\Studyplay\app-debug.apk`) sem precisar navegar até a pasta de build.

**How to apply:** Sempre que `gradlew assembleDebug` for executado com sucesso, executar o `cp` acima como passo final antes de reportar o resultado ao usuário.
