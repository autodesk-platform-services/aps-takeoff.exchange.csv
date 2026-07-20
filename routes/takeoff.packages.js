/////////////////////////////////////////////////////////////////////
// Copyright (c) Autodesk, Inc. All rights reserved
// Written by APS Partner Development
//
// Permission to use, copy, modify, and distribute this software in
// object code form for any purpose and without fee is hereby granted,
// provided that the above copyright notice appears in all copies and
// that both that copyright notice and the limited warranty and
// restricted rights notice below appear in all supporting
// documentation.
//
// AUTODESK PROVIDES THIS PROGRAM "AS IS" AND WITH ALL FAULTS.
// AUTODESK SPECIFICALLY DISCLAIMS ANY IMPLIED WARRANTY OF
// MERCHANTABILITY OR FITNESS FOR A PARTICULAR USE.  AUTODESK, INC.
// DOES NOT WARRANT THAT THE OPERATION OF THE PROGRAM WILL BE
// UNINTERRUPTED OR ERROR FREE.
/////////////////////////////////////////////////////////////////////

'use strict';   


var express = require('express'); 
var router = express.Router(); 

var bodyParser = require('body-parser');
var jsonParser = bodyParser.json(); 
var config = require('../config'); 

const { apiClientCallAsync } = require('./common/apiclient');
const { OAuth } = require('./common/oauth');
const { ProjectsApi } = require('forge-apis');


/////////////////////////////////////////////////////////////////////////////
// Add String.format() method if it's not existing
/////////////////////////////////////////////////////////////////////////////
if (!String.prototype.format) {
  String.prototype.format = function () {
      var args = arguments;
      return this.replace(/{(\d+)}/g, function (match, number) {
          return typeof args[number] != 'undefined'
              ? args[number]
              : match
              ;
      });
  };
}


const TokenType = {
  TWOLEGGED: 0,
  THREELEGGED: 1,
  NOT_SUPPORTED: 9
}

function normalizeProjectId(projectId) {
  if (!projectId) {
    return '';
  }
  return projectId.includes('.') ? projectId.split('.')[1] : projectId;
}

function mapFormaClassificationNodes(nodes) {
  return (nodes || []).map((node) => ({
    code: node.code || node.id || node.name || node.title || '',
    description: node.title || node.name || node.code || node.id || '',
    parentCode: node.parentId || node.parentCode || null
  }));
}

function isDataManagementUrn(version) {
  return typeof version === 'string' && version.startsWith('urn:adsk');
}

async function resolveContentViewName(projectId, contentView, accessToken) {
  const legacyName = (contentView.type === 'FILE_MODEL' ? contentView.view?.viewName : contentView.view?.sheetName) || contentView.name || '';
  const version = contentView.version?.value || contentView.version || '';

  if (!isDataManagementUrn(version)) {
    return legacyName;
  }

  const dmProjectId = projectId.startsWith('b.') ? projectId : `b.${projectId}`;
  const dmUrl = config.takeoff.URL.DATA_MANAGEMENT_VERSION.format(dmProjectId, encodeURIComponent(version));
  try {
    const response = await apiClientCallAsync('GET', dmUrl, accessToken);
    const versionData = response.body?.data || response.body || {};
    const resolvedName = versionData.attributes?.name || versionData.attributes?.displayName || versionData.attributes?.title || versionData.name || versionData.title || legacyName;
    return resolvedName || legacyName;
  } catch (err) {
    console.error('failed to resolve content view version', err);
    return legacyName;
  }
}

async function resolveClassificationReference(projectId, classificationRef, accessToken, treeNodeCache) {
  if (!classificationRef || typeof classificationRef !== 'object') {
    return classificationRef;
  }

  if (classificationRef.code || classificationRef.description || classificationRef.title || classificationRef.name) {
    return classificationRef;
  }

  if (!classificationRef.structureId || !classificationRef.nodeId) {
    return classificationRef;
  }

  const treeId = classificationRef.structureId;
  const cacheKey = `${projectId}:${treeId}`;
  let nodes = treeNodeCache.get(cacheKey);
  if (!nodes) {
    try {
      const treesUrl = config.takeoff.URL.FORMA_CLASSIFICATIONS_TREES.format(projectId);
      const treesRes = await apiClientCallAsync('GET', treesUrl, accessToken);
      const treeList = treesRes.body.results || treesRes.body || [];
      const targetTree = treeList.find((tree) => tree.id === treeId);
      if (!targetTree) {
        return classificationRef;
      }

      const nodesUrl = config.takeoff.URL.FORMA_CLASSIFICATIONS_NODES.format(projectId, treeId);
      const nodesRes = await apiClientCallAsync('GET', nodesUrl, accessToken);
      nodes = nodesRes.body.results || nodesRes.body || [];
      treeNodeCache.set(cacheKey, nodes);
    } catch (err) {
      console.error('failed to resolve forma classification node', err);
      return classificationRef;
    }
  }

  const matchedNode = (nodes || []).find((node) => node.id === classificationRef.nodeId);
  if (!matchedNode) {
    return classificationRef;
  }

  return {
    ...classificationRef,
    code: matchedNode.code || matchedNode.id || matchedNode.name || matchedNode.title || '',
    description: matchedNode.title || matchedNode.name || matchedNode.code || matchedNode.id || '',
    title: matchedNode.title || matchedNode.name || matchedNode.code || matchedNode.id || ''
  };
}

async function resolveTypeClassifications(projectId, takeoffTypes, accessToken) {
  const treeNodeCache = new Map();
  const resolvedTypes = [];

  for (const takeoffType of takeoffTypes || []) {
    const primaryDefinition = takeoffType.primaryQuantityDefinition || {};
    const classifications = Array.isArray(primaryDefinition.classifications) ? primaryDefinition.classifications : [];
    if (!classifications.length) {
      resolvedTypes.push(takeoffType);
      continue;
    }

    const resolvedClassifications = [];
    for (const classificationRef of classifications) {
      resolvedClassifications.push(await resolveClassificationReference(projectId, classificationRef, accessToken, treeNodeCache));
    }

    takeoffType.primaryQuantityDefinition = {
      ...primaryDefinition,
      classifications: resolvedClassifications
    };
    resolvedTypes.push(takeoffType);
  }

  return resolvedTypes;
}

///////////////////////////////////////////////////////////////////////
/// Middleware for obtaining a token for each request.
///////////////////////////////////////////////////////////////////////
router.use(async (req, res, next) => {
  const oauth = new OAuth(req.session);
  req.oauth_client = oauth.getClient();
  req.oauth_token = await oauth.getInternalToken();  
  next();   
});

/////////////////////////////////////////////////////////////////////////////////////////////
/// patch different data of takeoff type
/////////////////////////////////////////////////////////////////////////////////////////////
router.patch('/takeoff/info', jsonParser, async function (req, res) {
  const projectId = normalizeProjectId(req.body.projectId);
  const measurementSystem = req.body.measurementSystem;
  if (!projectId) {
    console.error('project id is not provided.');
    return (res.status(400).json({
      diagnostic: 'project id is not provided.'
    }));
  }  

  let takeoffUrl = null;
  let body = null;
  const takeoffData = req.body.takeoffData;
  switch( takeoffData ){
    case 'settings':{
      takeoffUrl = config.takeoff.URL.SETTINGS.format(projectId);
      body = {
        'measurementSystem': measurementSystem
      }
      break;
    };
  };
  let takeoffInfoRes = null;
  try {
    let newTakeoffInfoRes = await apiClientCallAsync('PATCH', takeoffUrl, req.oauth_token.access_token, body);
    takeoffInfoRes = newTakeoffInfoRes;
  } catch (err) {
    console.error(err)
    takeoffInfoRes = err;
  }
  return (res.status(200).json(takeoffInfoRes));
})

/////////////////////////////////////////////////////////////////////////////////////////////
/// post different data of takeoff type
/////////////////////////////////////////////////////////////////////////////////////////////
router.post('/takeoff/info', jsonParser, async function (req, res) {
  const projectId = normalizeProjectId(req.body.projectId);
  const systemId = req.body.systemId;
  const classificationName = req.body.classificationName;
  const classifications = req.body.classifications;
  const systemType = req.body.systemType;
  const packageName = req.body.packageName;
  const measurementSystem = req.body.measurementSystem;
  if (!projectId) {
    console.error('project id is not provided.');
    return (res.status(400).json({
      diagnostic: 'project id is not provided.'
    }));
  }  

  let takeoffUrl = null;
  let body = null;
  const takeoffData = req.body.takeoffData;
  switch( takeoffData ){
    case 'classifications_import':{
      takeoffUrl = config.takeoff.URL.CLASSIFICATIONS_IMPORT.format(projectId, systemId);
      body = {
        'name': classificationName,
        'classifications': classifications
      }
      break;
    };
    case 'classification_create':{
      takeoffUrl = config.takeoff.URL.CLASSIFICATION_SYSTEMS.format(projectId);
      body = {
        'name': classificationName,
        'type': systemType,
        'classifications': classifications
      }
      break;
    }
    case 'package_create': {
      takeoffUrl = config.takeoff.URL.PACKAGES_URL.format(projectId);
      body = {
        'name': packageName
      }
      break;
    }
  };
  let takeoffInfoRes = null;
  try {
    let newTakeoffInfoRes = await apiClientCallAsync('POST', takeoffUrl, req.oauth_token.access_token, body);
    takeoffInfoRes = newTakeoffInfoRes;
  } catch (err) {
    console.error(err)
    takeoffInfoRes = err;
  }
  return (res.status(200).json(takeoffInfoRes));
})


/////////////////////////////////////////////////////////////////////////////////////////////
/// get different data of takeoff type
/////////////////////////////////////////////////////////////////////////////////////////////
router.get('/takeoff/info', jsonParser, async function (req, res) {
  const projectId = normalizeProjectId(req.query.projectId);
  const packageId = req.query.packageId;
  const systemId = req.query.systemId;
  if (!projectId) {
    console.error('project id is not provided.');
    return (res.status(400).json({
      diagnostic: 'project id is not provided.'
    }));
  }  

  let takeoffUrl = null;
  const takeoffData = req.query.takeoffData;
  switch( takeoffData ){
    case 'packages':{
      takeoffUrl =  config.takeoff.URL.PACKAGES_URL.format(projectId);
      break;
    };
    case 'items':{
      takeoffUrl =  config.takeoff.URL.ITEMS_URL.format(projectId, packageId);
      break;
    };
    case 'types':{
      takeoffUrl = config.takeoff.URL.TAKEOFF_TYPES.format(projectId, packageId);
      break;
    };
    case 'systems':{
      takeoffUrl = config.takeoff.URL.CLASSIFICATION_SYSTEMS.format(projectId);
      break;
    };
    case 'classifications':{
      takeoffUrl = config.takeoff.URL.ALL_CLASSIFICATIONS.format(projectId, systemId);
      break;
    };
    case 'views':{
      takeoffUrl = config.takeoff.URL.CONTENT_VIEW.format(projectId, systemId);
      break;
    };
    case 'locations':{
      takeoffUrl = config.takeoff.URL.LOCATIONS.format(projectId);
      break;
    };
    case 'settings':{
      takeoffUrl = config.takeoff.URL.SETTINGS.format(projectId);
      break;
    }
  };
  let takeoffInfoRes = [];
  try {
    let newTakeoffInfoRes = await apiClientCallAsync('GET', takeoffUrl, req.oauth_token.access_token);
    if(takeoffData != 'settings' ){
      let results = newTakeoffInfoRes.body.results || newTakeoffInfoRes.body || [];
      if (takeoffData === 'types') {
        results = await resolveTypeClassifications(projectId, results, req.oauth_token.access_token);
      }
      if (takeoffData === 'views') {
        const resolvedViews = [];
        for (const contentView of results) {
          const resolvedName = await resolveContentViewName(projectId, contentView, req.oauth_token.access_token);
          resolvedViews.push({
            ...contentView,
            name: resolvedName
          });
        }
        results = resolvedViews;
      }
      takeoffInfoRes.push(...results);
      let offset = 0;
      while(newTakeoffInfoRes.body.pagination && newTakeoffInfoRes.body.pagination.nextUrl != null){
        offset += results.length;
        newTakeoffInfoRes = await apiClientCallAsync('GET', takeoffUrl, req.oauth_token.access_token, null, offset);
        const nextResults = newTakeoffInfoRes.body.results || newTakeoffInfoRes.body || [];
        if (takeoffData === 'types') {
          const resolvedNextResults = await resolveTypeClassifications(projectId, nextResults, req.oauth_token.access_token);
          takeoffInfoRes.push(...resolvedNextResults);
        } else if (takeoffData === 'views') {
          const resolvedViews = [];
          for (const contentView of nextResults) {
            const resolvedName = await resolveContentViewName(projectId, contentView, req.oauth_token.access_token);
            resolvedViews.push({
              ...contentView,
              name: resolvedName
            });
          }
          takeoffInfoRes.push(...resolvedViews);
        } else {
          takeoffInfoRes.push(...nextResults);
        }
      }
    }
    else{
      takeoffInfoRes = newTakeoffInfoRes;
    }
  } catch (err) {
    if (takeoffData === 'systems' && (err.statusCode === 409 || err.statusCode === 404 || err.statusCode === 400)) {
      try {
        const formaTreesUrl = config.takeoff.URL.FORMA_CLASSIFICATIONS_TREES.format(projectId);
        const formaTreesRes = await apiClientCallAsync('GET', formaTreesUrl, req.oauth_token.access_token);
        const formaTrees = formaTreesRes.body.results || formaTreesRes.body || [];
        return (res.status(200).json(formaTrees.map((tree) => ({
          id: tree.id,
          name: tree.name || tree.title || tree.id,
          type: 'FORMA_CLASSIFICATION_TREE'
        }))));
      } catch (formaErr) {
        console.error(formaErr);
        return (res.status(500).json({
          diagnostic: 'failed to get the takeoff info'
        }));
      }
    }

    if (takeoffData === 'classifications' && (err.statusCode === 409 || err.statusCode === 404 || err.statusCode === 400)) {
      try {
        const formaNodesUrl = config.takeoff.URL.FORMA_CLASSIFICATIONS_NODES.format(projectId, systemId);
        const formaNodesRes = await apiClientCallAsync('GET', formaNodesUrl, req.oauth_token.access_token);
        const formaNodes = formaNodesRes.body.results || formaNodesRes.body || [];
        return (res.status(200).json(mapFormaClassificationNodes(formaNodes)));
      } catch (formaErr) {
        console.error(formaErr);
        return (res.status(500).json({
          diagnostic: 'failed to get the takeoff info'
        }));
      }
    }

    console.error(err)
    return (res.status(500).json({
      diagnostic: 'failed to get the takeoff info'
    }));
  }
  return (res.status(200).json(takeoffInfoRes));
})


module.exports = router