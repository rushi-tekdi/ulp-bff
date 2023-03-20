import { Injectable, StreamableFile } from '@nestjs/common';

//custom imports
import axios from 'axios';
import jwt_decode from 'jwt-decode';
import { createWriteStream, writeFile } from 'fs';
import { Response, Request } from 'express';
import * as wkhtmltopdf from 'wkhtmltopdf';
import { UserDto } from './dto/user-dto';
import { schoolList } from './constlist/schoollist';

@Injectable()
export class SSOService {
  //axios call
  md5 = require('md5');
  qs = require('qs');
  moment = require('moment');
  //keycloak config
  keycloakCred = {
    grant_type: 'client_credentials',
    client_id: process.env.KEYCLOAK_CLIENT_ID,
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET,
  };
  //registerStudent
  async registerStudent(user: UserDto, response: Response) {
    if (user) {
      const clientToken = await this.getClientToken();
      if (clientToken?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_client_token_error',
          message: 'Bad Request for Keycloak Client Token',
          result: clientToken?.error,
        });
      } else {
        const issuerRes = await this.generateDid(user.studentId);
        if (issuerRes?.error) {
          return response.status(400).send({
            success: false,
            status: 'did_generate_error',
            message: 'DID Generate Failed. Try Again.',
            result: issuerRes?.error,
          });
        } else {
          var did = issuerRes[0].verificationMethod[0].controller;

          //register student keycloak
          let response_text = await this.registerStudentKeycloak(
            user,
            clientToken,
          );

          if (response_text?.error) {
            return response.status(400).send({
              success: false,
              status: 'keycloak_register_duplicate',
              message: 'Student Already Registered in Keycloak',
              result: response_text?.error,
            });
          } else {
            // sunbird registery
            let sb_rc_response_text = await this.sbrcRegistery(did, user);

            if (sb_rc_response_text?.error) {
              return response.status(400).send({
                success: false,
                status: 'sb_rc_register_error',
                message: 'Sunbird RC Student Registration Failed',
                result: sb_rc_response_text?.error,
              });
            } else if (sb_rc_response_text?.params?.status === 'SUCCESSFUL') {
              return response.status(201).send({
                success: true,
                status: 'registered',
                message:
                  'Student Account Created in Keycloak and Registered in Sunbird RC',
                result: sb_rc_response_text,
              });
            } else {
              return response.status(400).send({
                success: false,
                status: 'sb_rc_register_duplicate',
                message: 'Student Already Registered in Sunbird RC',
                result: sb_rc_response_text,
              });
            }
          }
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //loginStudent
  async loginStudent(username: string, password: string, response: Response) {
    if (username && password) {
      const studentToken = await this.getKeycloakToken(username, password);
      if (studentToken?.error) {
        return response.status(501).send({
          success: false,
          status: 'keycloak_invalid_credentials',
          message: studentToken?.error.message,
          result: null,
        });
      } else {
        const sb_rc_search = await this.searchStudent(username);
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC Student Search Failed',
            result: sb_rc_search?.error,
          });
        } else if (sb_rc_search.length !== 1) {
          return response.status(404).send({
            success: false,
            status: 'sb_rc_no_found',
            message: 'Student Not Found in Sunbird RC',
            result: null,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'login_success',
            message: 'Login Success',
            result: {
              userData: sb_rc_search,
              token: studentToken?.access_token,
            },
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //getDIDStudent
  async getDIDStudent(studentid: string, response: Response) {
    if (studentid) {
      const sb_rc_search = await this.searchStudent(studentid);
      if (sb_rc_search?.error) {
        return response.status(501).send({
          success: false,
          status: 'sb_rc_search_error',
          message: 'Sunbird RC Student Search Failed',
          result: null,
        });
      } else if (sb_rc_search.length !== 1) {
        return response.status(404).send({
          success: false,
          status: 'sb_rc_no_did_found',
          message: 'Student DID not Found in Sunbird RC',
          result: null,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'did_success',
          message: 'DID Found',
          result: sb_rc_search[0]?.did ? sb_rc_search[0].did : '',
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //credentialsStudent
  async credentialsStudent(token: string, response: Response) {
    if (token) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_student_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_student_token_error',
          message: 'Keycloak Student Token Expired',
          result: studentUsername,
        });
      } else {
        const sb_rc_search = await this.searchStudent(
          studentUsername?.preferred_username,
        );
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC Student Search Failed',
            result: sb_rc_search?.error.message,
          });
        } else if (sb_rc_search.length !== 1) {
          return response.status(404).send({
            success: false,
            status: 'sb_rc_no_did_found',
            message: 'Student DID not Found in Sunbird RC',
            result: null,
          });
        } else {
          let cred_search = await this.credSearch(sb_rc_search);

          if (cred_search?.error) {
            return response.status(501).send({
              success: false,
              status: 'cred_search_error',
              message: 'Student Credentials Search Failed',
              result: cred_search?.error,
            });
          } else if (cred_search.length === 0) {
            return response.status(404).send({
              success: false,
              status: 'cred_search_no_found',
              message: 'Student Credentials Not Found',
              result: null,
            });
          } else {
            return response.status(200).send({
              success: true,
              status: 'cred_success',
              message: 'Student Credentials Found',
              result: cred_search,
            });
          }
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token.',
        result: null,
      });
    }
  }

  //renderCredentials
  async renderCredentials(
    token: string,
    requestbody: any,
  ): Promise<string | StreamableFile> {
    if (token) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return 'Keycloak Student Token Expired';
      } else if (!studentUsername?.preferred_username) {
        return 'Keycloak Student Token Expired';
      } else {
        var data = JSON.stringify(requestbody);

        var config = {
          method: 'post',
          url: process.env.CRED_URL + '/credentials/render',
          headers: {
            'Content-Type': 'application/json',
          },
          data: data,
        };

        let render_response = null;
        await axios(config)
          .then(function (response) {
            render_response = response.data;
          })
          .catch(function (error) {
            //console.log(error);
          });
        if (render_response == null) {
          return 'Cred Render API Failed';
        } else {
          //return render_response;
          try {
            return new StreamableFile(
              await wkhtmltopdf(render_response, {
                pageSize: 'A4',
                disableExternalLinks: true,
                disableInternalLinks: true,
                disableJavascript: true,
              }),
            );
          } catch (e) {
            //console.log(e);
            return 'HTML to PDF Convert Fail';
          }
        }
      }
    } else {
      return 'Student Token Not Received';
    }
  }

  //renderCredentialsHTML
  async renderCredentialsHTML(
    token: string,
    requestbody: any,
    response: Response,
  ) {
    if (token) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_student_token_bad_request',
          message: 'Unauthorized',
          result: studentUsername?.error,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_student_token_error',
          message: 'Keycloak Student Token Expired',
          result: studentUsername,
        });
      } else {
        var data = JSON.stringify(requestbody);

        var config = {
          method: 'post',
          url: process.env.CRED_URL + '/credentials/render',
          headers: {
            'Content-Type': 'application/json',
          },
          data: data,
        };

        let render_response = null;
        await axios(config)
          .then(function (response) {
            //console.log(JSON.stringify(response.data));
            render_response = response.data;
          })
          .catch(function (error) {
            //console.log(error);
          });
        if (render_response == null) {
          return response.status(400).send({
            success: false,
            status: 'render_api_failed',
            message: 'Cred Render API Failed',
            result: null,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'render_api_success',
            message: 'Cred Render API Success',
            result: render_response,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token.',
        result: null,
      });
    }
  }

  //renderTemplate
  async renderTemplate(id: string, response: Response) {
    if (id) {
      var config = {
        method: 'get',
        url: process.env.SCHEMA_URL + '/rendering-template?id=' + id,
        headers: {},
      };
      let response_text = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_text = response.data;
        })
        .catch(function (error) {
          //console.log(error);
        });
      if (response_text == null) {
        return response.status(400).send({
          success: false,
          status: 'render_template_api_failed',
          message: 'Render Template API Failed',
          result: null,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'render_template_api_success',
          message: 'Render Template API Success',
          result: response_text,
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //renderTemplateSchema
  async renderTemplateSchema(id: string, response: Response) {
    if (id) {
      var config = {
        method: 'get',
        url: process.env.SCHEMA_URL + '/rendering-template/' + id,
        headers: {},
      };
      let response_text = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_text = response.data;
        })
        .catch(function (error) {
          //console.log(error);
        });
      if (response_text == null) {
        return response.status(400).send({
          success: false,
          status: 'render_template_schema_api_failed',
          message: 'Render Template Schema API Failed',
          result: null,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'render_template_schema_api_success',
          message: 'Render Template Schema API Success',
          result: response_text,
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //credentialsSearch
  async credentialsSearch(
    token: string,
    subjectId: string,
    response: Response,
  ) {
    if (token && subjectId) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_student_token_bad_request',
          message: 'Unauthorized',
          result: studentUsername?.error,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_student_token_error',
          message: 'Keycloak Student Token Expired',
          result: studentUsername,
        });
      } else {
        var data = JSON.stringify({
          subject: {
            id: subjectId,
          },
        });
        var config = {
          method: 'post',
          url: process.env.CRED_URL + '/credentials/search',
          headers: {
            'Content-Type': 'application/json',
          },
          data: data,
        };

        let render_response = null;
        await axios(config)
          .then(function (response) {
            //console.log(JSON.stringify(response.data));
            render_response = response.data;
          })
          .catch(function (error) {
            //console.log(error);
            render_response = { error: error };
          });

        if (render_response?.error) {
          return response.status(400).send({
            success: false,
            status: 'cred_search_api_failed',
            message: 'Cred Search API Failed',
            result: render_response,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'cred_search_api_success',
            message: 'Cred Search API Success',
            result: render_response,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token or subject ID.',
        result: null,
      });
    }
  }

  //credentialsSchema
  async credentialsSchema(id: string, response: Response) {
    if (id) {
      var config = {
        method: 'get',
        url: process.env.CRED_URL + '/credentials/schema/' + id,
        headers: {},
      };
      let response_text = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_text = response.data;
        })
        .catch(function (error) {
          //console.log(error);
          response_text = { error: error };
        });
      if (response_text?.error) {
        return response.status(400).send({
          success: false,
          status: 'cred_schema_api_failed',
          message: 'Cred Schema API Failed',
          result: response_text,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'cred_schema_api_success',
          message: 'Cred Schema API Success',
          result: response_text,
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //credentialsSchemaJSON
  async credentialsSchemaJSON(id: string, response: Response) {
    if (id) {
      var config = {
        method: 'get',
        url: process.env.SCHEMA_URL + '/schema/jsonld?id=' + id,
        headers: {},
      };
      let response_text = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_text = response.data;
        })
        .catch(function (error) {
          //console.log(error);
          response_text = { error: error };
        });
      if (response_text?.error) {
        return response.status(400).send({
          success: false,
          status: 'cred_schema_json_api_failed',
          message: 'Cred Schema JSON API Failed',
          result: response_text,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'cred_schema_json_api_success',
          message: 'Cred Schema JSON API Success',
          result: response_text,
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //userData
  async userData(token: string, digiacc: string, response: Response) {
    if (token && digiacc) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_user_token_bad_request',
          message: 'Unauthorized',
          result: studentUsername?.error,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_user_token_error',
          message: 'Keycloak User Token Expired',
          result: studentUsername,
        });
      } else {
        //get user detail
        //find if student account present in sb rc or not
        const sb_rc_search = await this.searchUsernameEntity(
          digiacc === 'ewallet' ? 'StudentDetail' : 'TeacherV1',
          studentUsername?.preferred_username,
        );
        console.log(sb_rc_search);
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC User Search Failed',
            result: sb_rc_search?.error,
          });
        } else if (sb_rc_search.length === 0) {
          // no student found then register
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_no_found',
            message: 'Sunbird RC User No Found',
            result: sb_rc_search?.error,
          });
        } else {
          //sent user value
          return response.status(200).send({
            success: true,
            status: 'sb_rc_search_found',
            message: 'Sunbird RC User Found',
            result: sb_rc_search[0],
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token or acc type.',
        result: null,
      });
    }
  }

  //schoolData
  async schoolData(token: string, udise: string, response: Response) {
    if (token && udise) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_user_token_bad_request',
          message: 'Unauthorized',
          result: studentUsername?.error,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_user_token_error',
          message: 'Keycloak User Token Expired',
          result: studentUsername,
        });
      } else {
        //get user detail
        //find if student account present in sb rc or not
        const sb_rc_search = await this.searchUdiseEntity(
          'SchoolDetail',
          udise,
        );
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC School Search Failed',
            result: sb_rc_search?.error,
          });
        } else if (sb_rc_search.length === 0) {
          // no student found then register
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_no_found',
            message: 'Sunbird RC School No Found',
            result: sb_rc_search?.error,
          });
        } else {
          //sent user value
          return response.status(200).send({
            success: true,
            status: 'sb_rc_search_found',
            message: 'Sunbird RC School Found',
            result: sb_rc_search[0],
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token or udise.',
        result: null,
      });
    }
  }

  //digilockerAuthorize
  async digilockerAuthorize(digiacc: string, response: Response) {
    //console.log(request);
    let digi_client_id = '';
    let digi_url_call_back_uri = '';
    if (digiacc === 'ewallet') {
      digi_client_id = process.env.EWA_CLIENT_ID;
      digi_url_call_back_uri = process.env.EWA_CALL_BACK_URL;
    } else if (digiacc === 'portal') {
      digi_client_id = process.env.URP_CLIENT_ID;
      digi_url_call_back_uri = process.env.URP_CALL_BACK_URL;
    }
    response.status(200).send({
      digiauthurl: `https://digilocker.meripehchaan.gov.in/public/oauth2/1/authorize?client_id=${digi_client_id}&response_type=code&redirect_uri=${digi_url_call_back_uri}&state=${digiacc}`,
    });
  }

  //digilockerToken
  async digilockerToken(
    response: Response,
    digiacc: string,
    auth_code: string,
  ) {
    if (digiacc && auth_code) {
      let digi_client_id = '';
      let digi_client_secret = '';
      let digi_url_call_back_uri = '';
      if (digiacc === 'ewallet') {
        digi_client_id = process.env.EWA_CLIENT_ID;
        digi_client_secret = process.env.EWA_CLIENT_SECRET;
        digi_url_call_back_uri = process.env.EWA_CALL_BACK_URL;
      } else if (digiacc === 'portal') {
        digi_client_id = process.env.URP_CLIENT_ID;
        digi_client_secret = process.env.URP_CLIENT_SECRET;
        digi_url_call_back_uri = process.env.URP_CALL_BACK_URL;
      }
      var data = this.qs.stringify({
        code: auth_code,
        grant_type: 'authorization_code',
        client_id: digi_client_id,
        client_secret: digi_client_secret,
        redirect_uri: digi_url_call_back_uri,
      });
      var config = {
        method: 'post',
        url: 'https://digilocker.meripehchaan.gov.in/public/oauth2/2/token',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: data,
      };

      let response_digi = null;
      await axios(config)
        .then(function (response) {
          console.log(JSON.stringify(response.data));
          response_digi = { data: response.data };
        })
        .catch(function (error) {
          //console.log(error);
          response_digi = { error: null };
        });
      if (response_digi?.error) {
        return response.status(401).send({
          success: false,
          status: 'digilocker_token_bad_request',
          message: 'Unauthorized',
          result: response_digi?.error,
        });
      } else {
        let id_token = response_digi?.data?.id_token;
        if (id_token) {
          let token_data: Object = await this.parseJwt(id_token);
          if (!token_data[0]?.sub) {
            return response.status(401).send({
              success: false,
              status: 'digilocker_token_bad_request',
              message: 'Unauthorized',
              result: response_digi?.error,
            });
          } else {
            const dob = await this.convertDate(token_data[0]?.birthdate);
            const username_name = token_data[0]?.given_name.split(' ')[0];
            const username_dob = await this.replaceChar(dob, '/', '');
            const auto_username = username_name + '@' + username_dob;
            let response_data = {
              meripehchanid: token_data[0]?.sub,
              name: token_data[0]?.given_name,
              mobile: token_data[0]?.phone_number,
              dob: dob,
              username: auto_username,
            };
            const sb_rc_search = await this.searchDigiEntity(
              digiacc === 'ewallet' ? 'StudentDetail' : 'TeacherV1',
              response_data?.meripehchanid,
            );
            if (sb_rc_search?.error) {
              return response.status(501).send({
                success: false,
                status: 'sb_rc_search_error',
                message: 'Sunbird RC Search Failed',
                result: sb_rc_search?.error.message,
              });
            } else if (sb_rc_search.length === 0) {
              return response.status(200).send({
                success: true,
                status: 'digilocker_login_success',
                message: 'Digilocker Login Success',
                result: response_data,
                digi: response_digi?.data,
                user: 'NO_FOUND',
              });
            } else {
              const auto_username =
                digiacc === 'ewallet'
                  ? response_data?.username
                  : response_data?.meripehchanid + '_teacher';
              const auto_password = await this.md5(
                auto_username + 'MjQFlAJOQSlWIQJHOEDhod',
              );
              const userToken = await this.getKeycloakToken(
                auto_username,
                auto_password,
              );
              if (userToken?.error) {
                return response.status(501).send({
                  success: false,
                  status: 'keycloak_invalid_credentials',
                  message: userToken?.error.message,
                  result: null,
                });
              } else {
                return response.status(200).send({
                  success: true,
                  status: 'digilocker_login_success',
                  message: 'Digilocker Login Success',
                  result: response_data,
                  digi: response_digi?.data,
                  user: 'FOUND',
                  userData: sb_rc_search,
                  token: userToken?.access_token,
                });
              }
            }
          }
        } else {
          return response.status(401).send({
            success: false,
            status: 'digilocker_token_bad_request',
            message: 'Unauthorized',
            result: response_digi?.error,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //digilockerRegister
  async digilockerRegister(
    response: Response,
    digiacc: string,
    userdata: any,
    digimpid: string,
  ) {
    if (digiacc && userdata && digimpid) {
      const clientToken = await this.getClientToken();
      if (clientToken?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_client_token_error',
          message: 'Bad Request for Keycloak Client Token',
          result: clientToken?.error,
        });
      } else {
        //register in keycloak
        const auto_username =
          digiacc === 'ewallet'
            ? userdata?.student?.username
            : digimpid + '_teacher';
        const auto_password = await this.md5(
          auto_username + 'MjQFlAJOQSlWIQJHOEDhod',
        );
        //register student keycloak
        let response_text = await this.registerUserKeycloak(
          auto_username,
          auto_password,
          clientToken,
        );

        if (response_text?.error) {
          return response.status(400).send({
            success: false,
            status: 'keycloak_register_duplicate',
            message: 'User Already Registered in Keycloak',
            result: response_text?.error,
          });
        } else {
          //ewallet registration student
          if (digiacc === 'ewallet') {
            //find if student account present in sb rc or not
            const sb_rc_search = await this.sbrcStudentSearch(
              userdata?.student?.studentName,
              userdata?.student?.dob,
            );
            if (sb_rc_search?.error) {
              return response.status(501).send({
                success: false,
                status: 'sb_rc_search_error',
                message: 'Sunbird RC Student Search Failed',
                result: sb_rc_search?.error,
              });
            } else if (sb_rc_search.length === 0) {
              // no student found then register
              // sunbird registery student
              let sb_rc_response_text = await this.sbrcInvite(
                userdata.student,
                'StudentDetail',
              );
              if (sb_rc_response_text?.error) {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_register_error',
                  message: 'Sunbird RC Student Registration Failed',
                  result: sb_rc_response_text?.error,
                });
              } else if (sb_rc_response_text?.params?.status === 'SUCCESSFUL') {
              } else {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_register_duplicate',
                  message: 'Student Already Registered in Sunbird RC',
                  result: sb_rc_response_text,
                });
              }
            } else {
              //update value found id
              const osid = sb_rc_search[0]?.osid;
              // sunbird registery student
              let sb_rc_response_text = await this.sbrcUpdate(
                {
                  meripehchanLoginId: userdata?.student?.meripehchanLoginId,
                  aadhaarID: userdata?.student?.aadhaarID,
                  schoolName: userdata?.student?.schoolName,
                  studentSchoolID: userdata?.student?.studentSchoolID,
                  phoneNo: userdata?.student?.phoneNo,
                  grade: userdata?.student?.grade,
                  username: userdata?.student?.username,
                },
                'StudentDetail',
                osid,
              );
              if (sb_rc_response_text?.error) {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_update_error',
                  message: 'Sunbird RC Student Update Failed',
                  result: sb_rc_response_text?.error,
                });
              } else if (sb_rc_response_text?.params?.status === 'SUCCESSFUL') {
              } else {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_update_error',
                  message: 'Sunbird RC Student Update Failed',
                  result: sb_rc_response_text,
                });
              }
            }
          }
          //portal registration teacher and school
          else {
            // sunbird registery teacher
            //get teacher did
            const issuerRes = await this.generateDid(
              userdata?.teacher?.meripehchanLoginId,
            );
            if (issuerRes?.error) {
              return response.status(400).send({
                success: false,
                status: 'did_generate_error_teacher',
                message: 'DID Generate Failed for Teacher. Try Again.',
                result: issuerRes?.error,
              });
            } else {
              var did = issuerRes[0].verificationMethod[0].controller;
              userdata.teacher.did = did;
              userdata.teacher.username = auto_username;
              let sb_rc_response_text = await this.sbrcInvite(
                userdata.teacher,
                'TeacherV1',
              );
              if (sb_rc_response_text?.error) {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_register_error',
                  message: 'Sunbird RC Teacher Registration Failed',
                  result: sb_rc_response_text?.error,
                });
              } else if (sb_rc_response_text?.params?.status === 'SUCCESSFUL') {
                // sunbird registery school
                //get school did
                const issuerRes = await this.generateDid(
                  userdata?.school?.udiseCode,
                );
                if (issuerRes?.error) {
                  return response.status(400).send({
                    success: false,
                    status: 'did_generate_error_school',
                    message: 'DID Generate Failed for School. Try Again.',
                    result: issuerRes?.error,
                  });
                } else {
                  var did = issuerRes[0].verificationMethod[0].controller;
                  userdata.school.did = did;
                  let sb_rc_response_text = await this.sbrcInvite(
                    userdata.school,
                    'SchoolDetail',
                  );
                  if (sb_rc_response_text?.error) {
                    return response.status(400).send({
                      success: false,
                      status: 'sb_rc_register_error',
                      message: 'Sunbird RC SchoolDetail Registration Failed',
                      result: sb_rc_response_text?.error,
                    });
                  } else if (
                    sb_rc_response_text?.params?.status === 'SUCCESSFUL'
                  ) {
                  } else {
                    return response.status(400).send({
                      success: false,
                      status: 'sb_rc_register_duplicate',
                      message: 'SchoolDetail Already Registered in Sunbird RC',
                      result: sb_rc_response_text,
                    });
                  }
                }
              } else {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_register_duplicate',
                  message: 'Teacher Already Registered in Sunbird RC',
                  result: sb_rc_response_text,
                });
              }
            }
          }
          //login and get token
          const userToken = await this.getKeycloakToken(
            auto_username,
            auto_password,
          );
          if (userToken?.error) {
            return response.status(501).send({
              success: false,
              status: 'keycloak_invalid_credentials',
              message: userToken?.error, //.message,
              result: null,
            });
          } else {
            return response.status(200).send({
              success: true,
              status: 'digilocker_login_success',
              message: 'Digilocker Login Success',
              user: 'FOUND',
              userData: userdata,
              token: userToken?.access_token,
            });
          }
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  async getStudentDetail(requestbody, response: Response) {
    console.log('456');
    let studentDetails = await this.studentDetails(requestbody);
    console.log('studentDetails', studentDetails);
    if (studentDetails) {
      return response.status(200).send({
        success: true,
        status: 'Success',
        message: 'Student details fetched successfully!',
        result: studentDetails,
      });
    } else {
      return response.status(200).send({
        success: false,
        status: 'Success',
        message: 'Unable to fetch student details!',
        result: null,
      });
    }
  }
  //digilockerAuthorize
  async udiseVerify(udiseid: string, response: Response) {
    //console.log(request);
    response.status(200).send({
      udiseCode: udiseid,
      schoolName: 'SWAMI DYALANANDA J.B SCHOOL ' + udiseid,
      schoolCategory: 1,
      schoolManagementCenter: 1,
      schoolManagementState: 11,
      schoolType: 3,
      classFrom: 1,
      classTo: 5,
      stateCode: '16',
      stateName: 'Tripura',
      districtName: 'WEST TRIPURA',
      blockName: 'AGARTALA MUNICIPAL COORPORATION',
      locationType: 2,
      headOfSchoolMobile: '89******42',
      respondentMobile: '88******96',
      alternateMobile: '',
      schoolEmail: '',
    });
  }

  //getSchoolList
  async getSchoolList(response: Response) {
    //console.log('hi');
    response.status(200).send(schoolList);
  }
  //getSchoolListUdise
  async getSchoolListUdise(udise, response: Response) {
    //console.log('hi');
    let obj = schoolList.find((o) => o.udiseCode === udise);
    if (obj) {
      response.status(200).send({ success: true, status: 'found', data: obj });
    } else {
      response.status(400).send({ success: false, status: 'no_found' });
    }
  }
  //helper function
  //get convert date and repalce character from string
  async convertDate(datetime) {
    if (!datetime) {
      return '';
    }
    let date_string = datetime.substring(0, 10);
    const datetest = this.moment(date_string, 'DD/MM/YYYY').format(
      'DD/MM/YYYY',
    );
    return datetest;
  }
  async replaceChar(replaceString, found, replace) {
    if (!replaceString) {
      return '';
    }
    const search = found;
    const replaceWith = replace;
    const result = replaceString.split(search).join(replaceWith);
    return result;
  }
  //get jwt token information
  async parseJwt(token) {
    if (!token) {
      return [];
    }
    const decoded = jwt_decode(token);
    return [decoded];
  }

  //get client token
  async getClientToken() {
    let data = this.qs.stringify({
      grant_type: this.keycloakCred.grant_type,
      client_id: this.keycloakCred.client_id,
      client_secret: this.keycloakCred.client_secret,
    });
    let config = {
      method: 'post',
      url:
        process.env.KEYCLOAK_URL +
        'realms/' +
        process.env.REALM_ID +
        '/protocol/openid-connect/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: data,
    };

    let response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        response_text = { error: error };
      });
    return response_text;
  }

  //get keycloak token after login
  async getKeycloakToken(username: string, password: string) {
    let data = this.qs.stringify({
      client_id: this.keycloakCred.client_id,
      username: username.toString(),
      password: password,
      grant_type: 'password',
      client_secret: this.keycloakCred.client_secret,
    });

    let config = {
      method: 'post',
      url:
        process.env.KEYCLOAK_URL +
        'realms/' +
        process.env.REALM_ID +
        '/protocol/openid-connect/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: data,
    };

    var response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log("data 516", JSON.stringify(response.data));
        response_text = response.data;
      })
      .catch(function (error) {
        //console.log("error 520");
        response_text = { error: error };
      });

    return response_text;
  }

  //generate did
  async generateDid(studentId: string) {
    let data = JSON.stringify({
      content: [
        {
          alsoKnownAs: [`did.${studentId}`],
          services: [
            {
              id: 'IdentityHub',
              type: 'IdentityHub',
              serviceEndpoint: {
                '@context': 'schema.identity.foundation/hub',
                '@type': 'UserServiceEndpoint',
                instance: ['did:test:hub.id'],
              },
            },
          ],
        },
      ],
    });

    let config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${process.env.DID_URL}/did/generate`,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let response_text = null;
    try {
      const response = await axios(config);
      //console.log("response did", response.data)
      response_text = response.data;
    } catch (error) {
      //console.log('error did', error);
      response_text = { error: error };
    }
    return response_text;
  }

  //search entity meripehchan
  async searchDigiEntity(entity: string, searchkey: string) {
    let data = JSON.stringify({
      filters: {
        meripehchanLoginId: {
          eq: searchkey.toString(),
        },
      },
    });

    let url = process.env.REGISTRY_URL + 'api/v1/' + entity + '/search';
    console.log(data + ' ' + url);
    let config = {
      method: 'post',
      url: url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //search student
  async searchStudent(studentId: string) {
    let data = JSON.stringify({
      filters: {
        studentSchoolID: {
          eq: studentId,
        },
      },
    });

    let config = {
      method: 'post',
      url: process.env.REGISTRY_URL + 'api/v1/StudentDetail/search',
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //search student
  async sbrcStudentSearch(studentName: string, dob: string) {
    let data = JSON.stringify({
      filters: {
        studentName: {
          eq: studentName,
        },
        dob: {
          eq: dob,
        },
      },
    });

    let config = {
      method: 'post',
      url: process.env.REGISTRY_URL + 'api/v1/StudentDetail/search',
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //search entity username
  async searchUsernameEntity(entity: string, searchkey: string) {
    let data = JSON.stringify({
      filters: {
        username: {
          eq: searchkey.toString(),
        },
      },
    });

    let url = process.env.REGISTRY_URL + 'api/v1/' + entity + '/search';
    console.log(data + ' ' + url);
    let config = {
      method: 'post',
      url: url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //search entity udise
  async searchUdiseEntity(entity: string, searchkey: string) {
    let data = JSON.stringify({
      filters: {
        udiseCode: {
          eq: searchkey.toString(),
        },
      },
    });

    let url = process.env.REGISTRY_URL + 'api/v1/' + entity + '/search';
    console.log(data + ' ' + url);
    let config = {
      method: 'post',
      url: url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //verify student token
  async verifyStudentToken(token: string) {
    let config = {
      method: 'get',
      url:
        process.env.KEYCLOAK_URL +
        'realms/' +
        process.env.REALM_ID +
        '/protocol/openid-connect/userinfo',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: 'Bearer ' + token,
      },
    };

    let response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        response_text = response?.data;
      })
      .catch(function (error) {
        //console.log(error);
        response_text = { error: error };
      });

    return response_text;
  }

  // register student keycloak
  async registerStudentKeycloak(user, clientToken) {
    let data = JSON.stringify({
      enabled: 'true',
      username: user.studentId,
      credentials: [
        {
          type: 'password',
          value: '1234',
          temporary: false,
        },
      ],
    });

    let config = {
      method: 'post',
      url:
        process.env.KEYCLOAK_URL +
        'admin/realms/' +
        process.env.REALM_ID +
        '/users',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + clientToken?.access_token,
      },
      data: data,
    };
    var response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        response_text = { error: error };
      });

    return response_text;
  }

  // sbrc registery
  async sbrcRegistery(did, user) {
    let data = JSON.stringify({
      did: did,
      aadhaarID: user.aadhaarId,
      studentName: user.studentName,
      schoolName: user.schoolName,
      schoolID: user.schoolId,
      studentSchoolID: user.studentId,
      phoneNo: user.phoneNo,
    });

    let config_sb_rc = {
      method: 'post',
      url: process.env.REGISTRY_URL + 'api/v1/StudentDetail/invite',
      headers: {
        'content-type': 'application/json',
      },
      data: data,
    };

    var sb_rc_response_text = null;
    await axios(config_sb_rc)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_response_text = { error: error };
      });

    return sb_rc_response_text;
  }

  // register user in keycloak
  async registerUserKeycloak(username, password, clientToken) {
    let data = JSON.stringify({
      enabled: 'true',
      username: username,
      credentials: [
        {
          type: 'password',
          value: password,
          temporary: false,
        },
      ],
    });

    let config = {
      method: 'post',
      url:
        process.env.KEYCLOAK_URL +
        'admin/realms/' +
        process.env.REALM_ID +
        '/users',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + clientToken?.access_token,
      },
      data: data,
    };
    var response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        response_text = { error: error };
      });

    return response_text;
  }

  // invite entity in registery
  async sbrcInvite(inviteSchema, entityName) {
    let data = JSON.stringify(inviteSchema);

    let config_sb_rc = {
      method: 'post',
      url: process.env.REGISTRY_URL + 'api/v1/' + entityName + '/invite',
      headers: {
        'content-type': 'application/json',
      },
      data: data,
    };

    var sb_rc_response_text = null;
    await axios(config_sb_rc)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_response_text = { error: error };
      });

    return sb_rc_response_text;
  }

  // invite entity in registery
  async sbrcUpdate(updateSchema, entityName, osid) {
    let data = JSON.stringify(updateSchema);

    let config_sb_rc = {
      method: 'put',
      url: process.env.REGISTRY_URL + 'api/v1/' + entityName + '/' + osid,
      headers: {
        'content-type': 'application/json',
      },
      data: data,
    };

    var sb_rc_response_text = null;
    await axios(config_sb_rc)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_response_text = { error: error };
      });

    return sb_rc_response_text;
  }

  // cred search

  async credSearch(sb_rc_search) {
    console.log('sb_rc_search', sb_rc_search);

    let data = JSON.stringify({
      subject: {
        id: sb_rc_search[0]?.did ? sb_rc_search[0].did : '',
      },
    });
    // let data = JSON.stringify({
    //   subjectId: sb_rc_search[0]?.did ? sb_rc_search[0].did : '',
    // });

    let config = {
      method: 'post',
      url: process.env.CRED_URL + '/credentials/search',
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let cred_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        cred_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        cred_search = { error: error };
      });

    return cred_search;
  }

  // student details
  async studentDetails(requestbody) {
    console.log('requestbody', requestbody);
    var data = JSON.stringify(requestbody);

    var config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${process.env.REGISTRY_URL}api/v1/StudentDetail/search`,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };

    try {
      let stdentDetailRes = await axios(config);
      return stdentDetailRes.data;
    } catch (err) {
      console.log('err');
    }
  }
}
