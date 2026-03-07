---
title: 'Broken Links'
excerpt: 'Technical explanation of broken links and how they affect website navigation, crawling, and search indexing.'
date: 2026-03-07
heroImage: './images/seo.webp'
isDraft: false
slug: 'broken-links'
tags: ['Troubleshooting', 'Technical SEO', 'Site Integrity']
author: ''
---

# Broken Links

## Overview

Broken links occur when hyperlinks on a website point to URLs that no longer exist or cannot be reached. These links typically return **HTTP 404 (Not Found)** or **410 (Gone)** responses. Broken links disrupt navigation for users and prevent search engine crawlers from reaching intended content, which can weaken internal linking signals and reduce crawl efficiency.

## Common Causes

- pages removed without updating internal links
- incorrect URLs entered into navigation menus or page content
- site migrations that changed URL structures without redirects
- external websites linking to outdated or deleted pages
- CMS plugins generating dynamic links that reference invalid URLs

## How the Problem Appears

- users encountering **404 Not Found** pages when clicking links
- SEO crawlers reporting broken internal links
- Search Console listing crawl errors for missing URLs
- internal links pointing to pages that no longer exist

## How It Is Diagnosed

- crawling the site using an SEO crawler to detect 404 responses
- reviewing **Search Console → Indexing → Pages** reports for missing URLs
- inspecting server logs for repeated requests to non-existent pages
- checking navigation menus and internal links for incorrect paths

## Typical Fix

- update internal links to point to valid pages
- implement **301 redirects** for pages moved to new URLs
- remove links referencing deleted content
- update external backlinks by redirecting outdated URLs

## Related Technical Issues

- [Redirect Errors](/insights/redirect-errors/)
- [Sitemap Errors](/insights/sitemap-errors/)
- [Website Errors](/insights/website-errors/)

## Technical Website Support

If broken links are affecting navigation or search engine crawling, technical troubleshooting may be required to locate and repair invalid URLs across the site.

[Technical Website Support](/)
