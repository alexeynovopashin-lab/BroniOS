#!/usr/bin/env python3
"""Upload the BroniOS test landing (this folder) to a Yandex Object Storage bucket (S3 API, stdlib only).

Keys and bucket name live outside the repo: ~/.config/bronios/s3.env with
  AWS_ACCESS_KEY_ID=...
  AWS_SECRET_ACCESS_KEY=...
  BUCKET=<bucket name in Yandex Cloud folder `bronios`>
Made by Alexey, never committed (the repo is public).
Uploads index.html and icon-192.png only. Nothing is deleted from the bucket.
Usage: python3 landing/deploy_yandex.py [--dry-run]
"""
import datetime, hashlib, hmac, os, sys, urllib.error, urllib.parse, urllib.request

HOST, REGION = "storage.yandexcloud.net", "ru-central1"
HERE = os.path.dirname(os.path.abspath(__file__))
FILES = {"index.html": "text/html; charset=utf-8", "icon-192.png": "image/png"}


def load_env():
    env = {}
    for line in open(os.path.expanduser("~/.config/bronios/s3.env")):
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.strip().split("=", 1)
            env[k] = v
    return env


def sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def request(method, bucket, path, ak, sk, body=b"", extra=None):
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    uri = "/" + bucket + "/" + urllib.parse.quote(path, safe="/-_.~")
    payload = hashlib.sha256(body).hexdigest()
    headers = {"host": HOST, "x-amz-content-sha256": payload, "x-amz-date": amz}
    signed = ";".join(sorted(headers))
    canon = "\n".join([method, uri, "", "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, payload])
    scope = f"{day}/{REGION}/s3/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
    k = sign(sign(sign(sign(("AWS4" + sk).encode(), day), REGION), "s3"), "aws4_request")
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    h = {k: v for k, v in headers.items() if k != "host"}
    h["Authorization"] = f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={signed}, Signature={sig}"
    h.update(extra or {})
    req = urllib.request.Request(f"https://{HOST}{uri}", data=body if method == "PUT" else None, headers=h, method=method)
    return urllib.request.urlopen(req, timeout=60)


def main():
    dry = "--dry-run" in sys.argv
    env = load_env()
    bucket, ak, sk = env["BUCKET"], env["AWS_ACCESS_KEY_ID"], env["AWS_SECRET_ACCESS_KEY"]
    for name, ctype in FILES.items():
        body = open(os.path.join(HERE, name), "rb").read()
        md5 = hashlib.md5(body).hexdigest()
        try:
            etag = request("HEAD", bucket, name, ak, sk).headers.get("ETag", "").strip('"')
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            etag = None
        if etag == md5:
            print(f"  = {name} (без изменений)")
            continue
        print(f"  {'~' if dry else '↑'} {name} ({len(body)} байт)")
        if not dry:
            request("PUT", bucket, name, ak, sk, body,
                    {"Content-Type": ctype, "Cache-Control": "no-cache"})
    print(f"Готово. Адрес: https://{bucket}.website.yandexcloud.net/")


if __name__ == "__main__":
    main()
