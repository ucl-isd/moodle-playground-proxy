# Moodle playground download proxy

The [Moodle playground](https://github.com/ucl-isd/moodle-playground) runs Moodle in the browser and installs plugins
from github zips. A web page can't read those zips straight from github, so the playground asks this proxy instead:

```
https://playground-proxy.preview-moodle.ucl.ac.uk/?url=https://github.com/<owner>/<repo>/archive/<commit>.zip
```

## Why not the playground's proxy

The playground comes with a proxy, but it can't be used for UCL:
- the one it points at, `github-proxy.exelearning.dev`, is a third party service
- its code (`scripts/github-proxy-worker.js` in the playground) has about ten modes (branches, pull requests,
  releases, raw files, feeds, and other hosts such as Google Drive and Dropbox), lets any site use it, and shows a
  page on its own address
- none of those can be switched off, so deploying it would mean editing it into this anyway
