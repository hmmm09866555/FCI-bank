package com.fci.bank;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);

        final String host = Uri.parse(BuildConfig.APP_URL).getHost();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (host != null && host.equals(u.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                v.loadDataWithBaseURL(null,
                    "<body style='background:#050505;color:#fff;font-family:sans-serif;text-align:center;padding-top:30vh'>"
                    + "<h2>Can't reach FCI</h2><p style='color:#999'>Check your connection.</p>"
                    + "<button style='padding:14px 28px;font-size:16px;border-radius:12px' onclick=\"location.href='"
                    + BuildConfig.APP_URL + "'\">Try again</button></body>", "text/html", "utf-8", null);
            }
        });

        if (state != null) web.restoreState(state); else web.loadUrl(BuildConfig.APP_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    // Back button: step back inside the app first, exit only from the top level.
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
            "(function(){try{if(stack&&stack.length){pop();return 1}}catch(e){}return 0})()",
            v -> { if (!"1".equals(v)) finish(); });
    }
}
