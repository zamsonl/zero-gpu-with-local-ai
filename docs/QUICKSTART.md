# Quick Start — run a notebook, open the chat

You do **not** need to create a website, a Cloudflare account, or install the model on your PC. The chat app is already provided. You need a browser and your own eligible Kaggle account. Kaggle runs the model using your allowance.

> **Caution:** Quick Start has **no compaction, no model/runtime caching, and no local coding agent**. For these features, use [Advanced Setup](https://github.com/zamsonl/zero-gpu-with-local-ai/blob/main/docs/SETUP.md) and **DOWNLOAD ME.zip**. Image generation and advanced recovery also belong to Advanced Setup.

## 1. Open the notebook

[Open the Quick Start notebook in Kaggle](https://www.kaggle.com/kernels/welcome?src=https://github.com/zamsonl/zero-gpu-with-local-ai/blob/main/notebooks/kaggle.ipynb).

If that link does not import it: sign in to Kaggle, choose **Create → New Notebook → File → Import Notebook**, and upload `notebooks/kaggle.ipynb` from this ZIP. Keep your notebook **private**.

Kaggle may ask you to verify your account before GPUs and Internet are available. If verification fails repeatedly, contact [Kaggle support](https://www.kaggle.com/contact).

## 2. Choose the GPU and run

In the notebook's **Settings** panel, select **Accelerator → GPU T4 x2** and turn **Internet on**. Leave the settings cell unchanged for your first run. Select **Run All**.

Wait for **READY**. Installation, downloads and GPU loading can take several minutes. A fresh session downloads the model again because Quick Start has no persistent model cache.

## 3. Click “Open the chat”

Click **Open the chat** in the notebook output. The supplied browser app connects automatically. No website deployment or Kaggle API-token setup is required.

If the supplied page is unavailable, double-click `web/index.html` in this ZIP. On its connection screen, paste the **whole link** printed by your notebook. It contains the server address and connection key, so the separate Key field can stay empty.

Keep that link private. Anyone with it can use your running model. Do not publish notebook outputs or share the link.

## When you finish

In the chat's **⋯** menu, choose **Shut the server down**. Also check Kaggle and stop the notebook session so its GPU allocation ends. Closing the chat tab alone does not prove that the GPU stopped.

For background use, **Save Version → Save & Run All (Commit)** produces the same link in that run's log. Keep the notebook private and check its final state when finished.

## Chats and longer conversations

Chats are saved in that browser on that device. Use **Settings → Your chats → Export all** for a backup, or **Import** to move them. Clearing browser data or using a private window can remove history. The supplied hosted app and the local file have separate browser storage.

Quick Start does not summarize earlier messages. When the input budget is reached it leaves older messages out of the active prompt; they remain in the saved transcript. Start a new chat or use Advanced Setup when you need compaction and longer tasks.

## Colab instead

[Open the Quick Start notebook in Colab](https://colab.research.google.com/github/zamsonl/zero-gpu-with-local-ai/blob/main/notebooks/colab.ipynb), select **Runtime → Change runtime type → T4 GPU**, then **Runtime → Run all** and keep the tab open. It uses a smaller quantization for one T4.

Colab's free managed runtimes restrict primarily using a web UI instead of the notebook. Check its [official FAQ](https://research.google.com/colaboratory/faq.html); availability and limits are controlled by the provider. Kaggle is the recommended Quick Start path.

## Common fixes

| What you see | What to do |
| --- | --- |
| No GPU or no Internet | Check notebook settings and account eligibility. |
| Offline | Run the notebook, wait for READY and use its newest link. |
| Wrong key | Paste the whole newest link. This connection key is not a Kaggle API token. |
| Downloading again | Expected in Quick Start. Use Advanced Setup for the private cache workflow. |
| Older instructions seem forgotten | Quick Start has no compaction. Back up the chat and use Advanced Setup for longer work. |

The GPU and cloud accounts are yours. Provider quotas and permitted uses still apply.
